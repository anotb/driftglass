import { randomUUID } from "node:crypto";

import {
  epistemicMemoryRefreshIsDue,
  recoverInterruptedSelfhostMemoryRefresh,
  refreshEpistemicMemoryLocally,
  type EpistemicRefreshQueued,
  type EpistemicRefreshResult,
} from "../../epistemic-memory";
import type { Env } from "../../types";

const DEFAULT_POLL_MS = 30_000;

export interface LocalMemoryRefresherOptions {
  readonly pollMs?: number;
  readonly logger?: (event: Readonly<Record<string, unknown>>) => void;
}

function boundedPollMs(value: number | undefined): number {
  const candidate = value ?? DEFAULT_POLL_MS;
  if (!Number.isSafeInteger(candidate) || candidate < 100 || candidate > 5 * 60_000) {
    throw new RangeError("memory pollMs must be an integer between 100 and 300000");
  }
  return candidate;
}

function errorText(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 4_000);
}

/**
 * One process-local coordinator around the canonical SQLite memory graph.
 * Refreshes are deterministic and idempotent; a hard stop leaves the graph
 * dirty so the next verified self-host process rebuilds it from saved state.
 */
export class LocalMemoryRefresher {
  readonly #env: () => Env;
  readonly #pollMs: number;
  readonly #logger?: LocalMemoryRefresherOptions["logger"];
  readonly #sessionId = randomUUID();
  #started = false;
  #stopping = false;
  #wake: (() => void) | null = null;
  #loop: Promise<void> | null = null;
  #inFlight: Promise<EpistemicRefreshQueued | EpistemicRefreshResult> | null = null;

  constructor(env: () => Env, options: LocalMemoryRefresherOptions = {}) {
    this.#env = env;
    this.#pollMs = boundedPollMs(options.pollMs);
    this.#logger = options.logger;
  }

  async initialize(): Promise<{ recoveredInterruptedRefresh: boolean }> {
    const recoveredInterruptedRefresh = await recoverInterruptedSelfhostMemoryRefresh(this.#env());
    return { recoveredInterruptedRefresh };
  }

  start(): void {
    if (this.#started) return;
    this.#started = true;
    this.#stopping = false;
    this.#loop = this.runLoop();
  }

  async close(): Promise<{ status: "clean"; inFlight: false }> {
    if (!this.#started) {
      await this.#inFlight;
      return { status: "clean", inFlight: false };
    }
    this.#stopping = true;
    this.#wake?.();
    await this.#loop;
    await this.#inFlight;
    this.#loop = null;
    this.#started = false;
    return { status: "clean", inFlight: false };
  }

  async refresh(options: { force?: boolean; maxStories?: number } = {}): Promise<EpistemicRefreshQueued | EpistemicRefreshResult> {
    if (this.#inFlight) return this.#inFlight;
    const executionId = `selfhost-memory:${this.#sessionId}:${randomUUID()}`;
    const running = refreshEpistemicMemoryLocally(this.#env(), { ...options, executionId });
    this.#inFlight = running;
    try {
      const result = await running;
      this.#logger?.({ level: "info", event: "local_memory_refresh", status: result.status });
      return result;
    } finally {
      if (this.#inFlight === running) this.#inFlight = null;
    }
  }

  /** One due check, exposed for bounded acceptance tests. */
  async tick(): Promise<{ due: boolean; status?: EpistemicRefreshQueued["status"] | EpistemicRefreshResult["status"] }> {
    const due = await epistemicMemoryRefreshIsDue(this.#env());
    if (!due) return { due: false };
    const result = await this.refresh();
    return { due: true, status: result.status };
  }

  private async runLoop(): Promise<void> {
    while (!this.#stopping) {
      await this.tick().catch((error) => {
        this.#logger?.({ level: "error", event: "local_memory_refresh_failed", message: errorText(error) });
      });
      if (!this.#stopping) await this.wait();
    }
  }

  private wait(): Promise<void> {
    return new Promise((resolve) => {
      let settled = false;
      const finish = (): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (this.#wake === finish) this.#wake = null;
        resolve();
      };
      const timer = setTimeout(finish, this.#pollMs);
      timer.unref?.();
      this.#wake = finish;
    });
  }
}
