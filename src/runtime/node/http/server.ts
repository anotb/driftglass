import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { performance } from "node:perf_hooks";
import {
  createRequestLifecycle,
  type HttpHandler,
  type RequestLifecycle,
} from "../../../http/contracts";
import {
  httpRouteTemplate,
  nodeRequestToWeb,
  safeTransportErrorCode,
  transportErrorResponse,
  writeWebResponse,
  NodeHttpTransportError,
} from "./adapter";
import {
  allowedHostAuthorities,
  formatHostAuthority,
  normalizeNodeHttpConfig,
  type NodeHttpConfig,
  type NormalizedNodeHttpConfig,
} from "./config";

export type NodeHttpLogEvent =
  | Readonly<{
      level: "info" | "warn" | "error";
      event: "http_request";
      method: string;
      routeTemplate: string;
      status: number;
      durationMs: number;
      errorCode?: string;
    }>
  | Readonly<{
      level: "warn";
      event: "http_client_error";
      routeTemplate: "/[transport]";
      status: number;
      errorCode: "headers_too_large" | "malformed_http";
    }>
  | Readonly<{
      level: "info" | "warn";
      event: "http_shutdown";
      shutdownStatus: "clean" | "forced";
      remainingBackgroundWork: number;
      durationMs: number;
    }>;

export type NodeHttpLogger = (event: NodeHttpLogEvent) => void;

export interface NodeHttpServerOptions extends NodeHttpConfig {
  readonly logger?: NodeHttpLogger;
}

export interface NodeHttpCloseResult {
  readonly status: "clean" | "forced";
  readonly remainingBackgroundWork: number;
  readonly durationMs: number;
}

export interface StartedNodeHttpServer {
  readonly server: Server;
  readonly address: AddressInfo;
  /** Canonical Request origin, never derived from an incoming Host/proxy header. */
  readonly origin: string;
  readonly config: NormalizedNodeHttpConfig;
  close(): Promise<NodeHttpCloseResult>;
}

function emit(logger: NodeHttpLogger | undefined, event: NodeHttpLogEvent): void {
  if (!logger) return;
  try {
    logger(Object.freeze({ ...event }));
  } catch {
    // Logging is observational and may not break the transport.
  }
}

function statusLevel(status: number): "info" | "warn" | "error" {
  if (status >= 500) return "error";
  if (status >= 400) return "warn";
  return "info";
}

function boundedMethod(method: string | undefined): string {
  const candidate = (method ?? "UNKNOWN").toUpperCase();
  return /^[A-Z]{1,24}$/.test(candidate) ? candidate : "UNKNOWN";
}

function closeServer(server: Server): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
    server.closeIdleConnections();
  });
}

async function drainTrackedWork(pending: Set<Promise<void>>): Promise<void> {
  while (pending.size > 0) await Promise.allSettled([...pending]);
}

async function closeServerAndDrain(
  server: Server,
  pending: Set<Promise<void>>,
  timeoutMs: number,
): Promise<NodeHttpCloseResult> {
  const startedAt = performance.now();
  const deadline = startedAt + timeoutMs;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const complete = (async () => {
    await closeServer(server);
    await drainTrackedWork(pending);
    return "complete" as const;
  })();
  const timeout = new Promise<"timeout">((resolve) => {
    const expire = (): void => {
      const remainingMs = deadline - performance.now();
      if (remainingMs > 0) {
        timer = setTimeout(expire, remainingMs);
        return;
      }
      server.closeAllConnections();
      resolve("timeout");
    };
    timer = setTimeout(expire, timeoutMs);
  });
  let result: "complete" | "timeout";
  try {
    result = await Promise.race([complete, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
  if (result === "complete") {
    return Object.freeze({
      status: "clean",
      remainingBackgroundWork: 0,
      durationMs: Math.max(0, Math.round((performance.now() - startedAt) * 100) / 100),
    });
  }
  void complete.catch(() => undefined);
  return Object.freeze({
    status: "forced",
    remainingBackgroundWork: pending.size,
    durationMs: Math.max(0, Math.round((performance.now() - startedAt) * 100) / 100),
  });
}

/**
 * Start an explicitly requested Node transport. Importing this module has no
 * side effects and does not create a self-host runtime or authorize writes.
 */
export async function startNodeHttpServer(
  handler: HttpHandler,
  options: NodeHttpServerOptions = {},
): Promise<StartedNodeHttpServer> {
  if (typeof handler !== "function") throw new TypeError("Node HTTP server requires an injected handler");
  const { logger, ...configInput } = options;
  const config = normalizeNodeHttpConfig(configInput);
  let origin = config.origin;
  let allowedHosts: ReadonlySet<string> = new Set();
  let draining = false;
  const backgroundWork = new Set<Promise<void>>();

  const trackLifecycle = (lifecycle: RequestLifecycle): void => {
    const work = lifecycle.drain();
    backgroundWork.add(work);
    void work.finally(() => backgroundWork.delete(work));
  };

  const server = createServer({ maxHeaderSize: config.maxHeaderSizeBytes }, (incoming, outgoing) => {
    const closeNewlyIdleConnection = (): void => {
      if (!draining) return;
      // A connection that was active during the initial shutdown sweep can
      // become idle only after its response finishes. Reap it on the next
      // turn so server.close() is not pinned by an otherwise idle keep-alive
      // socket. This remains graceful: closeIdleConnections never interrupts
      // an active request or response.
      setImmediate(() => {
        if (draining) server.closeIdleConnections();
      });
    };
    outgoing.once("finish", closeNewlyIdleConnection);
    outgoing.once("close", closeNewlyIdleConnection);
    void (async () => {
      const startedAt = performance.now();
      let adapted: ReturnType<typeof nodeRequestToWeb> | undefined;
      const lifecycle = createRequestLifecycle();
      let lifecycleTracked = false;
      const beginLifecycleDrain = (): void => {
        if (lifecycleTracked) return;
        lifecycleTracked = true;
        trackLifecycle(lifecycle);
      };
      let status = 500;
      let errorCode: string | undefined;
      const onResponseClosed = (): void => {
        if (!outgoing.writableFinished) adapted?.abort(new DOMException("Client disconnected", "AbortError"));
      };
      outgoing.once("close", onResponseClosed);
      try {
        if (draining) {
          outgoing.shouldKeepAlive = false;
          throw new NodeHttpTransportError(503, "server_draining", "Service is draining");
        }
        if (!origin) throw new NodeHttpTransportError(503, "server_starting", "Service is starting");
        adapted = nodeRequestToWeb(incoming, {
          origin,
          allowedHosts,
          maxHeadersCount: config.maxHeadersCount,
          maxRequestBodyBytes: config.maxRequestBodyBytes,
        });
        const response = await Promise.race([
          Promise.resolve(handler(adapted.request, lifecycle)),
          adapted.bodyFailure,
        ]);
        beginLifecycleDrain();
        if (!(response instanceof Response)) throw new TypeError("Injected HTTP handler must return a Response");
        status = response.status;
        if (draining) outgoing.shouldKeepAlive = false;
        if (adapted.hasUnreadBody()) outgoing.shouldKeepAlive = false;
        await writeWebResponse(outgoing, response, {
          requestMethod: incoming.method,
          signal: adapted.request.signal,
        });
      } catch (error) {
        errorCode = safeTransportErrorCode(error);
        if (error instanceof NodeHttpTransportError) outgoing.shouldKeepAlive = false;
        const response = transportErrorResponse(error);
        status = response.status;
        if (!outgoing.headersSent && !outgoing.destroyed) {
          try {
            await writeWebResponse(outgoing, response, { requestMethod: incoming.method });
          } catch {
            outgoing.destroy();
          }
        } else if (!outgoing.destroyed) {
          outgoing.destroy();
        }
      } finally {
        beginLifecycleDrain();
        outgoing.off("close", onResponseClosed);
        adapted?.dispose();
        emit(logger, {
          level: statusLevel(status),
          event: "http_request",
          method: boundedMethod(incoming.method),
          routeTemplate: httpRouteTemplate(incoming.url),
          status,
          durationMs: Math.max(0, Math.round((performance.now() - startedAt) * 100) / 100),
          ...(errorCode ? { errorCode } : {}),
        });
      }
    })();
  });

  server.maxHeadersCount = config.maxHeadersCount;
  server.headersTimeout = config.headersTimeoutMs;
  server.requestTimeout = config.requestTimeoutMs;
  server.keepAliveTimeout = config.keepAliveTimeoutMs;
  server.on("clientError", (error, socket) => {
    const overflow = (error as NodeJS.ErrnoException).code === "HPE_HEADER_OVERFLOW";
    const status = overflow ? 431 : 400;
    if (socket.writable) {
      socket.end(
        "HTTP/1.1 " + status + (status === 431 ? " Request Header Fields Too Large" : " Bad Request") +
        "\r\nConnection: close\r\nContent-Length: 0\r\n\r\n",
      );
    }
    emit(logger, {
      level: "warn",
      event: "http_client_error",
      routeTemplate: "/[transport]",
      status,
      errorCode: overflow ? "headers_too_large" : "malformed_http",
    });
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = (): void => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(config.port, config.host);
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    await closeServerAndDrain(server, backgroundWork, config.drainTimeoutMs).catch(() => undefined);
    throw new Error("Node HTTP server did not expose an IP address");
  }
  origin = origin ?? "http://" + formatHostAuthority(config.host, address.port);
  allowedHosts = allowedHostAuthorities(config, address.port);

  let closing: Promise<NodeHttpCloseResult> | null = null;
  return Object.freeze({
    server,
    address,
    origin,
    config,
    close(): Promise<NodeHttpCloseResult> {
      if (closing) return closing;
      draining = true;
      closing = closeServerAndDrain(server, backgroundWork, config.drainTimeoutMs).then((result) => {
        emit(logger, {
          level: result.status === "clean" ? "info" : "warn",
          event: "http_shutdown",
          shutdownStatus: result.status,
          remainingBackgroundWork: result.remainingBackgroundWork,
          durationMs: result.durationMs,
        });
        return result;
      });
      return closing;
    },
  });
}
