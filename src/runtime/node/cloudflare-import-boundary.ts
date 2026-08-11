/**
 * Explicit Node bundle boundary for modules shared with the Worker build.
 *
 * The self-host bundle aliases only the `cloudflare:workers` module specifier
 * to this file. Tracing is observational and safely becomes a pass-through.
 * Platform execution base classes fail on construction so an unsupported
 * Durable Object or Workflow can never silently run under Node.
 */

interface LocalTraceSpan {
  setAttribute(_name: string, _value: unknown): void;
}

const passThroughSpan: LocalTraceSpan = Object.freeze({
  setAttribute(): void {
    // User tracing is observational; local structured HTTP logs remain active.
  },
});

export const tracing = Object.freeze({
  enterSpan<T>(_name: string, callback: (span: LocalTraceSpan) => T): T {
    return callback(passThroughSpan);
  },
});

function unavailable(kind: string): never {
  throw new Error(`${kind} is a Cloudflare-only execution primitive and is unavailable in the experimental self-host runtime`);
}

export class DurableObject {
  constructor(..._args: unknown[]) {
    unavailable("DurableObject");
  }
}

export class WorkflowEntrypoint {
  constructor(..._args: unknown[]) {
    unavailable("WorkflowEntrypoint");
  }
}

export class WorkerEntrypoint {
  constructor(..._args: unknown[]) {
    unavailable("WorkerEntrypoint");
  }
}

export class RpcTarget {
  constructor(..._args: unknown[]) {
    unavailable("RpcTarget");
  }
}

export const env = Object.freeze({});
export const exports = Object.freeze({});
