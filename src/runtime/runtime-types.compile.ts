import type { IngestMessage } from "../types";
import type { CloudflareRuntimeServices } from "./cloudflare";

function compileRuntimeContract(runtime: CloudflareRuntimeServices, message: IngestMessage): void {
  runtime.queues.ingest.send(message, { contentType: "json" });
  runtime.queues.deadLetter.sendBatch(
    [{ body: message, contentType: "json" }],
    { delaySeconds: 5 },
  );
  runtime.workflows.mission.create({ id: "mission", params: { runId: "run", missionId: "mission" } });

  // @ts-expect-error queue keys are exact for the Cloudflare profile
  runtime.queues.missing;
  // @ts-expect-error workflow keys are exact for the Cloudflare profile
  runtime.workflows.missing;
  // @ts-expect-error batch content type belongs to each message, not batch options
  runtime.queues.ingest.sendBatch([], { contentType: "json" });
  // @ts-expect-error runtime identity is immutable after construction
  runtime.canonicalState = "local";
}

void compileRuntimeContract;
