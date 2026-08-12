/**
 * Runtime-neutral HTTP contracts.
 *
 * These types deliberately use only the standard Request/Response surface so
 * Cloudflare and local transports can inject product handlers without either
 * transport importing the other's entrypoint or platform bindings.
 */

export interface RequestLifecycle {
  /** Register response-independent work that must be observed during drain. */
  waitUntil(promise: Promise<unknown>): void;
  /** Stop accepting work and settle every registered promise without rethrowing it. */
  drain(): Promise<void>;
}

export type HttpHandler = (request: Request, lifecycle: RequestLifecycle) => Response | Promise<Response>;

export type HttpRouteMatch = "exact" | "prefix";

export interface HttpRoute {
  /** Stable diagnostic name. It is never derived from a request URL. */
  readonly name: string;
  /** Absolute path. Prefix matches stop on a path-segment boundary. */
  readonly path: string;
  readonly match?: HttpRouteMatch;
  readonly handler: HttpHandler;
}

export interface HttpRouterOptions {
  readonly routes?: readonly HttpRoute[];
  /** Optional dashboard/static fallback after every injected product route. */
  readonly assets?: HttpHandler;
  readonly service?: string;
  readonly version?: string;
}

export interface HttpRouter {
  fetch(request: Request, lifecycle?: RequestLifecycle): Promise<Response>;
}

/** Create a transport-neutral, rejection-safe request lifecycle. */
export function createRequestLifecycle(): RequestLifecycle {
  const pending = new Set<Promise<void>>();
  let accepting = true;
  let draining: Promise<void> | null = null;

  return Object.freeze({
    waitUntil(promise: Promise<unknown>): void {
      if (!accepting) throw new Error("Request lifecycle is already draining");
      if (!promise || typeof promise.then !== "function") {
        throw new TypeError("waitUntil requires a Promise");
      }
      const tracked = Promise.resolve(promise).then(
        () => undefined,
        () => undefined,
      );
      pending.add(tracked);
      void tracked.finally(() => pending.delete(tracked));
    },
    drain(): Promise<void> {
      if (draining) return draining;
      draining = (async () => {
        while (pending.size > 0) await Promise.allSettled([...pending]);
        accepting = false;
      })();
      return draining;
    },
  });
}
