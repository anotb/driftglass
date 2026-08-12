import { tracing } from "cloudflare:workers";
import { BrowserAdmissionDeferredError, waitForBrowserAdmission } from "./browser-admission";
import { getRenderProfile, recordRenderAttempt } from "./db";
import { BudgetDeferredError, reserve, settleReservation } from "./budget";
import type { BudgetReservation } from "./budget";
import { cdpEvaluationObject, cdpEvaluationValue, cdpMessageText, kitesurfExtractionExpression } from "./rendering-cdp";
import { assertPublicHttpUrl } from "./security";
import type { Env, ExecutionCapacity, RenderEngine, RenderProfile, RenderStrategy } from "./types";
import { fetchWithTimeout, htmlTitle, readableHtmlText, readBoundedResponseJson, readBoundedResponseText } from "./utils";

const MAX_RENDERED_BYTES = 3_000_000;
const MAX_CHROMIUM_RESPONSE_BYTES = 4_000_000;
const MAX_CHROMIUM_LINKS_BYTES = 1_000_000;
const MAX_KITESURF_ERROR_BYTES = 16_000;
const MAX_DIRECT_REDIRECTS = 5;
const CDP_TIMEOUT_MS = 22_000;
export const BROWSER_CALL_RESERVATION_MS = 30_000;
export const KITESURF_SESSION_RESERVATION_MS = 90_000;
export const BROWSER_CALL_TIMEOUT_MS = 28_000;
const CHROMIUM_NAVIGATION_TIMEOUT_MS = 16_000;
const CHROMIUM_ACTION_TIMEOUT_MS = 8_000;

class BrowserOperationTimeoutError extends Error {
  constructor() {
    super(`Browser call timed out after ${BROWSER_CALL_TIMEOUT_MS} ms`);
    this.name = "BrowserOperationTimeoutError";
  }
}

interface BrowserCallMeasurement {
  observedMs: number;
  chargedMs: number;
  uncertain: boolean;
}

class BrowserUsageMeter {
  private readonly calls: BrowserCallMeasurement[] = [];

  measured(observedMs: number, maximumMs = BROWSER_CALL_RESERVATION_MS): void {
    const observed = Number.isFinite(observedMs) ? Math.max(0, Math.ceil(observedMs)) : maximumMs;
    const charged = Math.max(1, Math.min(maximumMs, observed));
    this.calls.push({
      observedMs: observed,
      chargedMs: charged,
      uncertain: !Number.isFinite(observedMs) || observed > maximumMs,
    });
  }

  timedOut(observedMs: number, maximumMs = BROWSER_CALL_RESERVATION_MS): void {
    const observed = Number.isFinite(observedMs) ? Math.max(0, Math.ceil(observedMs)) : maximumMs;
    this.calls.push({ observedMs: observed, chargedMs: maximumMs, uncertain: true });
  }

  skipped(): void {
    this.calls.push({ observedMs: 0, chargedMs: 0, uncertain: false });
  }

  fillUnobserved(expectedCalls: number, observedMs: number, maximumMs = BROWSER_CALL_RESERVATION_MS): void {
    while (this.calls.length < expectedCalls) this.timedOut(observedMs, maximumMs);
  }

  get observedMs(): number {
    return this.calls.reduce((total, call) => total + call.observedMs, 0);
  }

  get chargedMs(): number {
    return this.calls.reduce((total, call) => total + call.chargedMs, 0);
  }

  get uncertain(): boolean {
    return this.calls.some((call) => call.uncertain);
  }
}

async function withBrowserDeadline<T>(operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => {
      const error = new BrowserOperationTimeoutError();
      controller.abort();
      reject(error);
    }, BROWSER_CALL_TIMEOUT_MS);
  });
  try {
    return await Promise.race([operation(controller.signal), deadline]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

function responseBrowserMs(response: Response, elapsedMs: number): number {
  const header = response.headers.get("x-browser-ms-used");
  const measured = header === null ? Number.NaN : Number(header);
  return Number.isFinite(measured) && measured >= 0 ? measured : elapsedMs;
}

interface CdpReply {
  id?: number;
  method?: string;
  sessionId?: string;
  result?: Record<string, unknown>;
  error?: { code?: number; message?: string; data?: unknown };
  params?: Record<string, unknown>;
}

interface PendingCommand {
  resolve: (value: Record<string, unknown>) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface PendingEvent {
  sessionId?: string;
  resolve: (value: Record<string, unknown>) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

class CdpConnection {
  private nextId = 1;
  private readonly pending = new Map<number, PendingCommand>();
  private readonly events = new Map<string, PendingEvent[]>();
  private closed = false;
  private terminalError: Error | null = null;
  private operationAborted = false;

  private readonly abortSignal?: AbortSignal;
  private readonly abortListener: () => void;

  constructor(private readonly socket: WebSocket, signal?: AbortSignal) {
    this.abortSignal = signal;
    this.abortListener = () => {
      const error = new Error("Kitesurf CDP session aborted");
      this.operationAborted = true;
      this.rejectPending(error);
    };
    socket.addEventListener("message", (event) => this.onMessage(event));
    socket.addEventListener("close", () => this.failAll(new Error("Kitesurf CDP session closed")));
    socket.addEventListener("error", () => this.failAll(new Error("Kitesurf CDP transport failed")));
    if (signal?.aborted) this.abortListener();
    else signal?.addEventListener("abort", this.abortListener, { once: true });
  }

  private rejectPending(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    for (const waiters of this.events.values()) {
      for (const waiter of waiters) {
        clearTimeout(waiter.timer);
        waiter.reject(error);
      }
    }
    this.events.clear();
  }

  private onMessage(event: MessageEvent): void {
    let raw: string;
    try {
      raw = cdpMessageText(event.data);
    } catch (error) {
      const message = error instanceof Error ? error : new Error(String(error));
      this.failAll(message);
      try {
        this.socket.close(1009, "CDP message too large");
      } catch {
        // Ignore close races after rejecting pending commands.
      }
      return;
    }

    let payload: CdpReply;
    try {
      payload = JSON.parse(raw) as CdpReply;
    } catch {
      return;
    }

    if (typeof payload.id === "number") {
      const command = this.pending.get(payload.id);
      if (!command) return;
      clearTimeout(command.timer);
      this.pending.delete(payload.id);
      if (payload.error) {
        command.reject(new Error(`CDP ${payload.error.code ?? "error"}: ${payload.error.message ?? "unknown failure"}`));
      } else {
        command.resolve(payload.result ?? {});
      }
      return;
    }

    if (!payload.method) return;
    const waiters = this.events.get(payload.method) ?? [];
    const remaining: PendingEvent[] = [];
    for (const waiter of waiters) {
      if (waiter.sessionId && waiter.sessionId !== payload.sessionId) {
        remaining.push(waiter);
        continue;
      }
      clearTimeout(waiter.timer);
      waiter.resolve(payload.params ?? {});
    }
    if (remaining.length) this.events.set(payload.method, remaining);
    else this.events.delete(payload.method);
  }

  private failAll(error: Error): void {
    if (this.closed) return;
    this.closed = true;
    this.terminalError = error;
    this.rejectPending(error);
  }

  private sendCommand(
    method: string,
    params: Record<string, unknown> = {},
    sessionId?: string,
    timeoutMs = CDP_TIMEOUT_MS,
    allowAfterAbort = false,
  ): Promise<Record<string, unknown>> {
    if (this.closed) return Promise.reject(this.terminalError ?? new Error("Kitesurf CDP session is closed"));
    if (this.operationAborted && !allowAfterAbort) {
      return Promise.reject(new Error("Kitesurf CDP session is aborted"));
    }
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP command timed out: ${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }

  send(method: string, params: Record<string, unknown> = {}, sessionId?: string, timeoutMs = CDP_TIMEOUT_MS): Promise<Record<string, unknown>> {
    return this.sendCommand(method, params, sessionId, timeoutMs);
  }

  waitFor(method: string, sessionId?: string, timeoutMs = CDP_TIMEOUT_MS): Promise<Record<string, unknown>> {
    if (this.closed) return Promise.reject(this.terminalError ?? new Error("Kitesurf CDP session is closed"));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const active = this.events.get(method) ?? [];
        this.events.set(method, active.filter((candidate) => candidate.resolve !== resolve));
        reject(new Error(`CDP event timed out: ${method}`));
      }, timeoutMs);
      const waiters = this.events.get(method) ?? [];
      waiters.push({ sessionId, resolve, reject, timer });
      this.events.set(method, waiters);
    });
  }

  private async confirmBrowserClose(): Promise<boolean> {
    if (this.closed) return false;
    let removeCloseListener: (() => void) | undefined;
    const cleanClose = new Promise<boolean>((resolve) => {
      const listener = (event: CloseEvent): void => resolve(event.code === 1000 || event.code === 1001);
      removeCloseListener = () => this.socket.removeEventListener("close", listener);
      this.socket.addEventListener("close", listener, { once: true });
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<boolean>((resolve) => {
      timer = setTimeout(() => resolve(false), 2_500);
    });
    const command = this.sendCommand("Browser.close", {}, undefined, 2_500, true)
      .then(() => true)
      .catch(() => new Promise<boolean>(() => undefined));
    try {
      return await Promise.race([command, cleanClose, timeout]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      removeCloseListener?.();
    }
  }

  async dispose(): Promise<boolean> {
    const closeConfirmed = await this.confirmBrowserClose();
    try {
      this.socket.close(1000, "done");
    } catch {
      // Ignore close races.
    }
    this.failAll(new Error("Kitesurf CDP session disposed"));
    this.abortSignal?.removeEventListener("abort", this.abortListener);
    return closeConfirmed;
  }
}

export interface RenderAttemptSummary {
  engine: RenderEngine;
  ok: boolean;
  elapsedMs: number;
  browserMs?: number;
  contentLength: number;
  truncated?: boolean;
  error?: string;
}

export interface RenderLink {
  url: string;
  text: string;
}

export interface RenderResult {
  engine: RenderEngine;
  text: string;
  html?: string;
  title?: string;
  finalUrl?: string;
  links?: RenderLink[];
  truncated?: boolean;
  elapsedMs: number;
  browserMs?: number;
  attempts: RenderAttemptSummary[];
}

function recentFailure(profile: RenderProfile | null): boolean {
  if (!profile?.last_failure_at) return false;
  return Date.now() - new Date(profile.last_failure_at).getTime() < 24 * 60 * 60 * 1000;
}

export function selectRenderOrder(
  profile: RenderProfile | null,
  strategy: RenderStrategy = "adaptive",
): RenderEngine[] {
  if (strategy === "direct") return ["direct"];
  if (strategy === "kitesurf") return ["kitesurf"];
  if (strategy === "chromium") return ["chromium"];

  if (
    profile?.preferred_engine === "chromium" &&
    profile.kitesurf_consecutive_failures >= 2 &&
    recentFailure(profile)
  ) {
    return ["chromium", "kitesurf"];
  }
  return ["kitesurf", "chromium"];
}

async function connectKitesurf(binding: BrowserBinding, signal: AbortSignal): Promise<CdpConnection> {
  const response = await binding.fetch("http://fake.host/v1/devtools/browser?browser=kitesurf", {
    signal,
    headers: {
      Upgrade: "websocket",
      "cf-brapi-client": "driftglass@0.9.0",
    },
  });
  if (!response.webSocket) {
    const detail = await readBoundedResponseText(
      response,
      MAX_KITESURF_ERROR_BYTES,
      "Kitesurf connection error exceeds 16 KB",
    ).catch((error) => error instanceof Error ? error.message : String(error));
    throw new Error(`Kitesurf connection failed (${response.status})${detail ? `: ${detail.slice(0, 300)}` : ""}`);
  }
  response.webSocket.accept();
  return new CdpConnection(response.webSocket, signal);
}

interface KitesurfLifecycle {
  started: boolean;
  closeConfirmed: boolean;
}

async function renderKitesurf(
  url: URL,
  binding: BrowserBinding,
  signal: AbortSignal,
  lifecycle: KitesurfLifecycle,
  selector?: string,
  includeLinks = false,
): Promise<Omit<RenderResult, "attempts">> {
  const started = Date.now();
  const connection = await connectKitesurf(binding, signal);
  lifecycle.started = true;
  try {
    const targetsReply = await connection.send("Target.getTargets");
    const targetInfos = Array.isArray(targetsReply.targetInfos) ? targetsReply.targetInfos as Array<Record<string, unknown>> : [];
    let targetId = targetInfos.find((target) => target.type === "page")?.targetId as string | undefined;
    if (!targetId) {
      const created = await connection.send("Target.createTarget", { url: "about:blank" });
      targetId = created.targetId as string | undefined;
    }
    if (!targetId) throw new Error("Kitesurf returned no page target");

    const attached = await connection.send("Target.attachToTarget", { targetId, flatten: true });
    const sessionId = attached.sessionId as string | undefined;
    if (!sessionId) throw new Error("Kitesurf could not attach to the page target");

    await Promise.all([
      connection.send("Page.enable", {}, sessionId),
      connection.send("Runtime.enable", {}, sessionId),
    ]);

    const loadEvent = connection.waitFor("Page.loadEventFired", sessionId, 16_000).catch(() => ({}));
    const navigation = await connection.send("Page.navigate", { url: url.toString() }, sessionId);
    if (navigation.errorText) throw new Error(`Kitesurf navigation failed: ${navigation.errorText}`);
    await loadEvent;

    for (let attempt = 0; attempt < 8; attempt += 1) {
      const ready = await connection.send(
        "Runtime.evaluate",
        { expression: "document.readyState", returnByValue: true },
        sessionId,
        3_000,
      );
      const state = cdpEvaluationValue(ready);
      if (state === "complete" || state === "interactive") break;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    await new Promise((resolve) => setTimeout(resolve, 350));

    const expression = kitesurfExtractionExpression(selector, includeLinks);
    const evaluated = await connection.send(
      "Runtime.evaluate",
      { expression, returnByValue: true, awaitPromise: true },
      sessionId,
      7_500,
    );
    const value = cdpEvaluationObject(evaluated);
    const text = String(value.text ?? "").slice(0, MAX_RENDERED_BYTES);
    const html = String(value.html ?? "").slice(0, MAX_RENDERED_BYTES);
    if (typeof value.finalUrl !== "string") throw new Error("Kitesurf returned no final page URL");
    // Navigation already occurred; this prevents a non-public redirect from becoming returned content.
    const finalUrl = assertPublicHttpUrl(value.finalUrl).toString();
    if (!text.trim() && !html.trim()) throw new Error("Kitesurf returned no usable page content");
    return {
      engine: "kitesurf",
      text,
      html,
      title: typeof value.title === "string" ? value.title : undefined,
      finalUrl,
      links: Array.isArray(value.links)
        ? (value.links as Array<Record<string, unknown>>).map((link) => ({ url: String(link.url ?? ""), text: String(link.text ?? "") })).filter((link) => link.url)
        : undefined,
      truncated: value.truncated === true,
      elapsedMs: Date.now() - started,
    };
  } finally {
    lifecycle.closeConfirmed = await connection.dispose();
  }
}

export async function browserMarkdown(response: Response, signal?: AbortSignal): Promise<string> {
  const body = await readBoundedResponseText(
    response,
    MAX_CHROMIUM_RESPONSE_BYTES,
    "Chromium Quick Action response exceeds 4 MB",
    signal,
  );
  if (!body) return "";
  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.includes("json")) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(body) as unknown;
    } catch {
      throw new Error("Chromium Quick Action returned malformed JSON");
    }
    if (typeof parsed === "string") return parsed;
    if (parsed && typeof parsed === "object") {
      const record = parsed as Record<string, unknown>;
      for (const key of ["markdown", "result", "content", "text"]) {
        if (typeof record[key] === "string") return record[key] as string;
      }
      if (record.result && typeof record.result === "object") {
        if (Array.isArray(record.result)) {
          const selectedText = record.result.flatMap((entry) => {
            if (!entry || typeof entry !== "object" || !("results" in entry) || !Array.isArray(entry.results)) return [];
            return entry.results.flatMap((match: unknown) => {
              if (!match || typeof match !== "object" || !("text" in match) || typeof match.text !== "string") return [];
              return match.text;
            });
          }).join("\n\n");
          if (selectedText.trim()) return selectedText;
        }
        const nested = record.result as Record<string, unknown>;
        for (const key of ["markdown", "content", "text"]) {
          if (typeof nested[key] === "string") return nested[key] as string;
        }
      }
    }
    return "";
  }
  return body;
}

async function runChromiumCall<T>(
  operation: () => Promise<Response>,
  consume: (response: Response, signal: AbortSignal) => Promise<T>,
  meter: BrowserUsageMeter,
  db: D1Database,
  executionCapacity: ExecutionCapacity,
): Promise<T> {
  try {
    await waitForBrowserAdmission(db, "quick-action", executionCapacity);
  } catch (error) {
    meter.skipped();
    throw error;
  }
  const started = Date.now();
  let response: Response | undefined;
  try {
    const value = await withBrowserDeadline(async (signal) => {
      response = await operation();
      if (signal.aborted) {
        await response.body?.cancel("browser call timed out").catch(() => undefined);
        throw new BrowserOperationTimeoutError();
      }
      return consume(response, signal);
    });
    if (!response) throw new Error("Chromium Quick Action returned no response");
    meter.measured(responseBrowserMs(response, Date.now() - started));
    return value;
  } catch (error) {
    const elapsedMs = Date.now() - started;
    if (error instanceof BrowserOperationTimeoutError) meter.timedOut(elapsedMs);
    else meter.measured(elapsedMs);
    throw error;
  }
}

async function renderChromium(
  url: URL,
  binding: BrowserBinding,
  meter: BrowserUsageMeter,
  db: D1Database,
  executionCapacity: ExecutionCapacity,
  selector?: string,
  includeLinks = false,
): Promise<Omit<RenderResult, "attempts">> {
  const started = Date.now();
  const boundedOptions = {
    gotoOptions: { timeout: CHROMIUM_NAVIGATION_TIMEOUT_MS, waitUntil: "domcontentloaded" as const },
    actionTimeout: CHROMIUM_ACTION_TIMEOUT_MS,
  };
  const contentRequest = selector
    ? runChromiumCall(
        () => binding.quickAction("scrape", { url: url.toString(), elements: [{ selector }], ...boundedOptions }),
        async (response, signal) => {
          if (!response.ok) throw new Error(`Chromium Quick Action returned ${response.status}`);
          return (await browserMarkdown(response, signal)).slice(0, MAX_RENDERED_BYTES);
        },
        meter,
        db,
        executionCapacity,
      )
    : runChromiumCall(
        () => binding.quickAction("markdown", { url: url.toString(), ...boundedOptions }),
        async (response, signal) => {
          if (!response.ok) throw new Error(`Chromium Quick Action returned ${response.status}`);
          return (await browserMarkdown(response, signal)).slice(0, MAX_RENDERED_BYTES);
        },
        meter,
        db,
        executionCapacity,
      );
  let text: string;
  try {
    text = await contentRequest;
  } catch (error) {
    if (includeLinks) meter.skipped();
    throw error;
  }
  if (!text.trim()) {
    if (includeLinks) meter.skipped();
    throw new Error("Chromium Quick Action returned no usable text");
  }
  const links = includeLinks
    ? await runChromiumCall(
        () => binding.quickAction("links", { url: url.toString(), ...boundedOptions }),
        async (response, signal): Promise<RenderLink[]> => {
          if (!response.ok) throw new Error(`Chromium links Quick Action returned ${response.status}`);
          const payload = await readBoundedResponseJson<unknown>(
            response,
            MAX_CHROMIUM_LINKS_BYTES,
            "Chromium links response exceeds 1 MB",
            signal,
          );
          const value = payload && typeof payload === "object" && "result" in payload
            ? (payload as { result?: unknown }).result
            : payload;
          if (!Array.isArray(value)) throw new Error("Chromium links Quick Action returned an invalid result");
          return value.map((entry) => typeof entry === "string"
            ? { url: entry, text: "" }
            : { url: String((entry as Record<string, unknown>)?.url ?? ""), text: String((entry as Record<string, unknown>)?.text ?? "") })
            .filter((entry) => entry.url);
        },
        meter,
        db,
        executionCapacity,
      )
    : undefined;
  return {
    engine: "chromium",
    text,
    links,
    truncated: false,
    elapsedMs: Date.now() - started,
    browserMs: meter.observedMs,
  };
}

function isHttpRedirect(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

async function directResponse(initialUrl: URL): Promise<{ response: Response; finalUrl: URL }> {
  let url = initialUrl;
  for (let redirects = 0; ; redirects += 1) {
    const response = await fetchWithTimeout(url, {
      redirect: "manual",
      headers: {
        accept: "text/html,application/xhtml+xml,application/json;q=0.9,text/plain;q=0.8",
        "user-agent": "Driftglass/0.9 (public render inspector)",
      },
    });
    const location = response.headers.get("location");
    if (!isHttpRedirect(response.status) || !location) {
      return {
        response,
        finalUrl: assertPublicHttpUrl(response.url || url.toString()),
      };
    }
    if (response.body) await response.body.cancel("following validated redirect").catch(() => undefined);
    if (redirects >= MAX_DIRECT_REDIRECTS) throw new Error("Direct fetch exceeded the redirect limit");
    url = assertPublicHttpUrl(new URL(location, url).toString());
  }
}

async function renderDirect(url: URL): Promise<Omit<RenderResult, "attempts">> {
  const started = Date.now();
  const { response, finalUrl } = await directResponse(url);
  if (!response.ok) throw new Error(`Direct fetch returned HTTP ${response.status}`);
  const contentType = response.headers.get("content-type") ?? "";
  const raw = await readBoundedResponseText(
    response,
    MAX_RENDERED_BYTES,
    "Page is larger than the 3 MB direct-fetch limit",
  );
  const text = contentType.includes("html") ? readableHtmlText(raw) : raw;
  if (!text.trim()) throw new Error("Direct fetch returned no usable text");
  return {
    engine: "direct",
    text,
    html: contentType.includes("html") ? raw : undefined,
    title: contentType.includes("html") ? htmlTitle(raw) : undefined,
    finalUrl: finalUrl.toString(),
    elapsedMs: Date.now() - started,
    browserMs: 0,
  };
}

export interface AdaptiveRenderInput {
  url: URL;
  env: Env;
  sourceId?: string;
  selector?: string;
  strategy?: RenderStrategy;
  includeLinks?: boolean;
}

function browserCallsForAttempt(engine: Exclude<RenderEngine, "direct">, includeLinks: boolean): number {
  return engine === "chromium" && includeLinks ? 2 : 1;
}

async function reserveBrowserCalls(
  input: AdaptiveRenderInput,
  engine: Exclude<RenderEngine, "direct">,
  callCount: number,
): Promise<{ reservation: BudgetReservation; executionCapacity: ExecutionCapacity }> {
  const requested = engine === "kitesurf"
    ? KITESURF_SESSION_RESERVATION_MS
    : callCount * BROWSER_CALL_RESERVATION_MS;
  const result = await reserve(input.env.DB, "browser_ms", requested, {
    sourceId: input.sourceId,
    hostname: input.url.hostname.toLowerCase(),
    engine,
    callCount,
    operation: "render",
  });
  if (!result.allowed || !result.reservation) {
    throw new BudgetDeferredError("browser_ms", requested, result.remaining);
  }
  return {
    reservation: result.reservation,
    executionCapacity: result.executionCapacity,
  };
}

async function persistBrowserAttempt(input: {
  db: D1Database;
  reservation: BudgetReservation;
  sourceId?: string;
  hostname: string;
  engine: Exclude<RenderEngine, "direct">;
  ok: boolean;
  elapsedMs: number;
  observedBrowserMs: number;
  chargedBrowserMs: number;
  contentLength?: number;
  error?: string;
  operation: "render" | "screenshot";
  uncertain: boolean;
}): Promise<void> {
  const outcomes = await Promise.allSettled([
    settleReservation(input.db, input.reservation, input.chargedBrowserMs, {
      sourceId: input.sourceId,
      hostname: input.hostname,
      engine: input.engine,
      ok: input.ok,
      operation: input.operation,
      observedBrowserMs: input.observedBrowserMs,
      measurementUncertain: input.uncertain,
    }),
    recordRenderAttempt(input.db, {
      sourceId: input.sourceId,
      hostname: input.hostname,
      engine: input.engine,
      ok: input.ok,
      elapsedMs: input.elapsedMs,
      browserMs: input.observedBrowserMs,
      contentLength: input.contentLength,
      error: input.error,
    }),
  ]);
  for (const [index, outcome] of outcomes.entries()) {
    if (outcome.status === "fulfilled") continue;
    console.error(JSON.stringify({
      event: index === 0 ? "browser_budget_settlement_failed" : "browser_attempt_record_failed",
      engine: input.engine,
      operation: input.operation,
      error: outcome.reason instanceof Error ? outcome.reason.name : "UnknownError",
    }));
  }
}

async function renderAdaptiveInner(input: AdaptiveRenderInput): Promise<RenderResult> {
  const hostname = input.url.hostname.toLowerCase();
  const profile = await getRenderProfile(input.env.DB, hostname);
  const attempts: RenderAttemptSummary[] = [];
  const errors: string[] = [];

  for (const engine of selectRenderOrder(profile, input.strategy ?? "adaptive")) {
    if (engine === "direct") {
      const started = Date.now();
      try {
        const result = await renderDirect(input.url);
        attempts.push({
          engine,
          ok: true,
          elapsedMs: result.elapsedMs,
          browserMs: 0,
          contentLength: result.text.length || result.html?.length || 0,
          truncated: result.truncated,
        });
        return { ...result, attempts };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        attempts.push({ engine, ok: false, elapsedMs: Date.now() - started, contentLength: 0, error: message });
        errors.push(`${engine}: ${message}`);
        continue;
      }
    }
    if (!input.env.BROWSER) throw new Error("Cloudflare browser binding is unavailable");
    const browserEngine = engine as Exclude<RenderEngine, "direct">;
    const callCount = browserCallsForAttempt(browserEngine, input.includeLinks === true);
    const { reservation, executionCapacity } = await reserveBrowserCalls(input, browserEngine, callCount);
    const meter = new BrowserUsageMeter();
    const started = Date.now();
    let browserStartedAt = started;
    let result: Omit<RenderResult, "attempts"> | undefined;
    let failure: unknown;
    const kitesurfLifecycle: KitesurfLifecycle = { started: false, closeConfirmed: false };
    try {
      if (browserEngine === "kitesurf") {
        await waitForBrowserAdmission(input.env.DB, "session", executionCapacity);
        browserStartedAt = Date.now();
        kitesurfLifecycle.started = true;
        result = await withBrowserDeadline((signal) => renderKitesurf(
          input.url,
          input.env.BROWSER!,
          signal,
          kitesurfLifecycle,
          input.selector,
          input.includeLinks,
        ));
        const browserElapsedMs = Date.now() - browserStartedAt;
        if (kitesurfLifecycle.closeConfirmed) meter.measured(browserElapsedMs, KITESURF_SESSION_RESERVATION_MS);
        else meter.timedOut(browserElapsedMs, KITESURF_SESSION_RESERVATION_MS);
      } else {
        result = await renderChromium(
          input.url,
          input.env.BROWSER,
          meter,
          input.env.DB,
          executionCapacity,
          input.selector,
          input.includeLinks,
        );
      }
    } catch (error) {
      failure = error;
      if (browserEngine === "kitesurf") {
        const browserElapsedMs = Date.now() - browserStartedAt;
        if (!kitesurfLifecycle.started) {
          if (meter.chargedMs === 0) meter.skipped();
        } else if (kitesurfLifecycle.closeConfirmed) {
          meter.measured(browserElapsedMs, KITESURF_SESSION_RESERVATION_MS);
        } else {
          meter.timedOut(browserElapsedMs, KITESURF_SESSION_RESERVATION_MS);
        }
      }
    }
    const elapsedMs = Math.max(1, Date.now() - started);
    meter.fillUnobserved(
      callCount,
      elapsedMs,
      browserEngine === "kitesurf" ? KITESURF_SESSION_RESERVATION_MS : BROWSER_CALL_RESERVATION_MS,
    );
    const message = failure instanceof Error ? failure.message : failure === undefined ? undefined : String(failure);
    const summary: RenderAttemptSummary = {
      engine: browserEngine,
      ok: failure === undefined,
      elapsedMs,
      browserMs: meter.observedMs,
      contentLength: result?.text.length || result?.html?.length || 0,
      truncated: result?.truncated,
      ...(message ? { error: message } : {}),
    };
    attempts.push(summary);
    await persistBrowserAttempt({
      db: input.env.DB,
      reservation,
      sourceId: input.sourceId,
      hostname,
      engine: browserEngine,
      ok: summary.ok,
      elapsedMs,
      observedBrowserMs: meter.observedMs,
      chargedBrowserMs: meter.chargedMs,
      contentLength: summary.contentLength,
      error: message,
      operation: "render",
      uncertain: meter.uncertain,
    });
    if (failure !== undefined) {
      if (failure instanceof BrowserAdmissionDeferredError) throw failure;
      errors.push(`${browserEngine}: ${message ?? "unknown failure"}`);
      if (browserEngine === "kitesurf" && kitesurfLifecycle.started && !kitesurfLifecycle.closeConfirmed) break;
      if (browserEngine === "chromium" && failure instanceof BrowserOperationTimeoutError) break;
      continue;
    }
    if (!result) throw new Error(`${browserEngine} rendering returned no result`);
    return { ...result, elapsedMs, browserMs: meter.observedMs, attempts };
  }
  throw new Error(`Adaptive rendering failed (${errors.join("; ")})`);
}

export async function renderAdaptive(input: AdaptiveRenderInput): Promise<RenderResult> {
  // Keep renderer admission safe even when a new caller omits its own validation.
  const admittedInput = { ...input, url: assertPublicHttpUrl(input.url.toString()) };
  return tracing.enterSpan("driftglass.render.adaptive", async (span) => {
    span.setAttribute("driftglass.render.hostname", admittedInput.url.hostname.toLowerCase());
    span.setAttribute("driftglass.render.strategy", admittedInput.strategy ?? "adaptive");
    span.setAttribute("driftglass.source.id", admittedInput.sourceId);
    const result = await renderAdaptiveInner(admittedInput);
    span.setAttribute("driftglass.render.engine", result.engine);
    span.setAttribute("driftglass.render.attempts", result.attempts.length);
    span.setAttribute("driftglass.render.content_length", result.text.length || result.html?.length || 0);
    span.setAttribute("driftglass.render.truncated", result.truncated === true);
    return result;
  });
}

export function renderEngineLabel(engine: RenderEngine): string {
  if (engine === "kitesurf") return "Cloudflare Kitesurf";
  if (engine === "chromium") return "Cloudflare Chromium";
  return "Direct fetch";
}

async function captureKitesurfScreenshotInner(input: {
  url: URL;
  binding: BrowserBinding;
  signal: AbortSignal;
  lifecycle: KitesurfLifecycle;
  width?: number;
  height?: number;
}): Promise<Uint8Array> {
  const connection = await connectKitesurf(input.binding, input.signal);
  input.lifecycle.started = true;
  try {
    const targetsReply = await connection.send("Target.getTargets");
    const targetInfos = Array.isArray(targetsReply.targetInfos) ? targetsReply.targetInfos as Array<Record<string, unknown>> : [];
    let targetId = targetInfos.find((target) => target.type === "page")?.targetId as string | undefined;
    if (!targetId) {
      const created = await connection.send("Target.createTarget", { url: "about:blank" });
      targetId = created.targetId as string | undefined;
    }
    if (!targetId) throw new Error("Kitesurf returned no page target");
    const attached = await connection.send("Target.attachToTarget", { targetId, flatten: true });
    const sessionId = attached.sessionId as string | undefined;
    if (!sessionId) throw new Error("Kitesurf could not attach to the preview target");
    await Promise.all([
      connection.send("Page.enable", {}, sessionId),
      connection.send("Runtime.enable", {}, sessionId),
      connection.send("Emulation.setDeviceMetricsOverride", {
        width: Math.max(640, Math.min(2400, input.width ?? 1200)),
        height: Math.max(360, Math.min(1600, input.height ?? 630)),
        deviceScaleFactor: 1,
        mobile: false,
      }, sessionId),
    ]);
    const loaded = connection.waitFor("Page.loadEventFired", sessionId, 16_000).catch(() => ({}));
    const navigation = await connection.send("Page.navigate", { url: input.url.toString() }, sessionId);
    if (navigation.errorText) throw new Error(`Kitesurf preview navigation failed: ${navigation.errorText}`);
    await loaded;
    await new Promise((resolve) => setTimeout(resolve, 650));
    const evaluatedUrl = await connection.send(
      "Runtime.evaluate",
      { expression: "location.href", returnByValue: true },
      sessionId,
      3_000,
    );
    const finalUrl = cdpEvaluationValue(evaluatedUrl);
    if (typeof finalUrl !== "string") throw new Error("Kitesurf returned no final preview URL");
    // Navigation already occurred; reject the result before any redirected page is captured.
    assertPublicHttpUrl(finalUrl);
    const captured = await connection.send("Page.captureScreenshot", {
      format: "png",
      fromSurface: true,
      captureBeyondViewport: false,
    }, sessionId, 12_000);
    const data = captured.data;
    if (typeof data !== "string" || !data) throw new Error("Kitesurf returned no screenshot bytes");
    return Uint8Array.from(atob(data), (character) => character.charCodeAt(0));
  } finally {
    input.lifecycle.closeConfirmed = await connection.dispose();
  }
}

export async function captureKitesurfScreenshot(input: {
  url: URL;
  env: Env;
  width?: number;
  height?: number;
}): Promise<Uint8Array> {
  const admittedUrl = assertPublicHttpUrl(input.url.toString());
  if (!input.env.BROWSER) throw new Error("Cloudflare browser binding is unavailable");
  const hostname = admittedUrl.hostname.toLowerCase();
  const reservationResult = await reserve(input.env.DB, "browser_ms", KITESURF_SESSION_RESERVATION_MS, {
    hostname,
    engine: "kitesurf",
    callCount: 1,
    operation: "screenshot",
  });
  if (!reservationResult.allowed || !reservationResult.reservation) {
    throw new BudgetDeferredError("browser_ms", KITESURF_SESSION_RESERVATION_MS, reservationResult.remaining);
  }
  const started = Date.now();
  let browserStartedAt = started;
  const meter = new BrowserUsageMeter();
  const lifecycle: KitesurfLifecycle = { started: false, closeConfirmed: false };
  let bytes: Uint8Array | undefined;
  let failure: unknown;
  try {
    await waitForBrowserAdmission(input.env.DB, "session", reservationResult.executionCapacity);
    browserStartedAt = Date.now();
    lifecycle.started = true;
    bytes = await withBrowserDeadline((signal) => captureKitesurfScreenshotInner({
      url: admittedUrl,
      binding: input.env.BROWSER!,
      signal,
      lifecycle,
      width: input.width,
      height: input.height,
    }));
    const browserElapsedMs = Date.now() - browserStartedAt;
    if (lifecycle.closeConfirmed) meter.measured(browserElapsedMs, KITESURF_SESSION_RESERVATION_MS);
    else meter.timedOut(browserElapsedMs, KITESURF_SESSION_RESERVATION_MS);
  } catch (error) {
    failure = error;
    const browserElapsedMs = Date.now() - browserStartedAt;
    if (!lifecycle.started) meter.skipped();
    else if (lifecycle.closeConfirmed) meter.measured(browserElapsedMs, KITESURF_SESSION_RESERVATION_MS);
    else meter.timedOut(browserElapsedMs, KITESURF_SESSION_RESERVATION_MS);
  }
  const elapsedMs = Math.max(1, Date.now() - started);
  meter.fillUnobserved(1, elapsedMs, KITESURF_SESSION_RESERVATION_MS);
  const message = failure instanceof Error ? failure.message : failure === undefined ? undefined : String(failure);
  await persistBrowserAttempt({
    db: input.env.DB,
    reservation: reservationResult.reservation,
    hostname,
    engine: "kitesurf",
    ok: failure === undefined,
    elapsedMs,
    observedBrowserMs: meter.observedMs,
    chargedBrowserMs: meter.chargedMs,
    contentLength: bytes?.byteLength,
    error: message,
    operation: "screenshot",
    uncertain: meter.uncertain,
  });
  if (failure !== undefined) throw failure;
  if (!bytes) throw new Error("Kitesurf returned no screenshot bytes");
  return bytes;
}
