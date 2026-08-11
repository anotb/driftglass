import {
  recordSourceRunIngestAttemptFailure,
  recordSourceRunIngestOutcome,
  recordUnresolvedIngestDeadLetter,
  reconcileInboxReceiptQueueClaim,
} from "./db";
import { ingestMessage } from "./ingest";
import {
  INGEST_QUEUE_MESSAGE_MAX_BYTES,
  serializedIngestMessageBytes,
  utf8ByteLength,
} from "./ingest-queue";
import { persistEmergencyQuarantineRecovery } from "./quarantine-recovery";
import { sha256 } from "./security";
import { deleteTerminalTrackedSourceOutboxRun } from "./source-ingest-outbox";
import type { Env, IngestMessage } from "./types";

function errorText(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 500);
}

/** Cloudflare Queue delivery ordinals start at one; source-run state stores retries. */
function queueRetryCount(attempts: number): number {
  return Math.max(0, Math.floor(Number.isFinite(attempts) ? attempts : 1) - 1);
}

function tracking(message: IngestMessage): { runId: string; itemIndex: number } | null {
  if (
    typeof message.sourceRunId === "string" && message.sourceRunId.length > 0 &&
    Number.isSafeInteger(message.sourceRunItemIndex) && Number(message.sourceRunItemIndex) >= 0
  ) {
    return { runId: message.sourceRunId, itemIndex: Number(message.sourceRunItemIndex) };
  }
  return null;
}

function hasPartialTracking(message: IngestMessage): boolean {
  return message.sourceRunId !== undefined || message.sourceRunItemIndex !== undefined;
}

function isTerminalSourceRunStatus(status: string | undefined): boolean {
  return status === "success" || status === "partial" || status === "failed";
}

async function cleanupTerminalTrackedSourceOutbox(
  env: Env,
  input: { queueMessageId: string; sourceId: string; runId: string; status?: string },
): Promise<void> {
  if (!isTerminalSourceRunStatus(input.status)) return;
  await deleteTerminalTrackedSourceOutboxRun(env.DB, input.runId, input.sourceId).catch((error) => {
    console.error(JSON.stringify({
      message: "Unable to clean terminal tracked source outbox",
      queueMessageId: input.queueMessageId,
      sourceId: input.sourceId,
      sourceRunId: input.runId,
      error: errorText(error),
    }));
  });
}

async function consumePrimaryMessage(message: Message<IngestMessage>, env: Env): Promise<void> {
  const tracked = tracking(message.body);
  try {
    if (!tracked && hasPartialTracking(message.body)) throw new Error("Malformed source-run tracking metadata");
    const ingested = await ingestMessage(env, message.body);
    if (tracked) {
      const receipt = await recordSourceRunIngestOutcome(env.DB, {
        runId: tracked.runId,
        sourceId: message.body.sourceId,
        itemIndex: tracked.itemIndex,
        outcome: ingested.inserted ? "inserted" : "duplicate",
        itemId: ingested.itemId,
        retryCount: queueRetryCount(message.attempts),
      });
      if (!receipt.runFound || !receipt.receiptRecorded) {
        throw new Error("Tracked source-run receipt could not be persisted");
      }
      await cleanupTerminalTrackedSourceOutbox(env, {
        queueMessageId: message.id,
        sourceId: message.body.sourceId,
        runId: tracked.runId,
        status: receipt.status,
      });
    }
    if (message.body.emailReceiptClaim) {
      const reconciled = await reconcileInboxReceiptQueueClaim(
        env.DB,
        message.body.sourceId,
        message.body.emailReceiptClaim.messageId,
        message.body.emailReceiptClaim.claimToken,
      );
      if (!reconciled) throw new Error("Email receipt claim could not be reconciled after ingest");
    }
    message.ack();
  } catch (error) {
    if (tracked) {
      await recordSourceRunIngestAttemptFailure(env.DB, {
        runId: tracked.runId,
        sourceId: message.body.sourceId,
        error: errorText(error),
        retryCount: queueRetryCount(message.attempts),
      }).catch((receiptError) => console.error(JSON.stringify({
        message: "Unable to record tracked ingest attempt failure",
        queueMessageId: message.id,
        sourceId: message.body.sourceId,
        sourceRunId: tracked.runId,
        error: errorText(receiptError),
      })));
    }
    console.error(JSON.stringify({
      message: "Ingest Queue message failed",
      queueMessageId: message.id,
      sourceId: message.body.sourceId,
      sourceRunId: tracked?.runId ?? null,
      attempts: message.attempts,
      error: errorText(error),
    }));
    message.retry({ delaySeconds: 30 });
  }
}

async function persistRecoverableDeadLetter(
  message: Message<IngestMessage>,
  env: Env,
  queueName: string,
  reason: string,
): Promise<void> {
  const bodyJson = JSON.stringify(message.body);
  if (typeof bodyJson !== "string") throw new Error("Exhausted ingest message is not JSON serializable");
  const bodyBytes = utf8ByteLength(bodyJson);
  if (bodyBytes > INGEST_QUEUE_MESSAGE_MAX_BYTES || serializedIngestMessageBytes(message.body) > INGEST_QUEUE_MESSAGE_MAX_BYTES) {
    throw new Error(`Exhausted ingest recovery body exceeds ${INGEST_QUEUE_MESSAGE_MAX_BYTES} bytes`);
  }
  await recordUnresolvedIngestDeadLetter(env.DB, {
    queueMessageId: message.id,
    queueName,
    sourceId: message.body.sourceId,
    provider: message.body.provider,
    sourceRunId: message.body.sourceRunId,
    sourceRunItemIndex: message.body.sourceRunItemIndex,
    attempts: message.attempts,
    reason,
    bodyJson,
    bodyHash: await sha256(bodyJson),
    bodyBytes,
    emailReceiptClaim: message.body.emailReceiptClaim,
  });
}

async function persistDeadLetterMessageToD1(
  message: Message<IngestMessage>,
  env: Env,
  queueName: string,
): Promise<void> {
  const tracked = tracking(message.body);
  if (tracked) {
    const receipt = await recordSourceRunIngestOutcome(env.DB, {
      runId: tracked.runId,
      sourceId: message.body.sourceId,
      itemIndex: tracked.itemIndex,
      outcome: "failed",
      error: "Primary ingest Queue retries were exhausted",
    });
    // Terminal source-run accounting and recovery are deliberately distinct.
    // Even a successfully failed receipt keeps the exact bounded body available
    // for an owner retry, which starts a fresh untracked ingest attempt.
    await persistRecoverableDeadLetter(
      message,
      env,
      queueName,
      receipt.runFound && receipt.receiptRecorded
        ? "Tracked source-run item exhausted primary Queue retries"
        : receipt.runFound
          ? "Tracked source run could not accept the exhausted item receipt"
          : "Tracked source run was missing when primary retries were exhausted",
    );
    if (receipt.runFound && receipt.receiptRecorded) {
      // The private recovery body is durable before the terminal producer body
      // is retired, so a crash cannot remove both recovery paths.
      await cleanupTerminalTrackedSourceOutbox(env, {
        queueMessageId: message.id,
        sourceId: message.body.sourceId,
        runId: tracked.runId,
        status: receipt.status,
      });
    }
    return;
  }
  await persistRecoverableDeadLetter(
    message,
    env,
    queueName,
    hasPartialTracking(message.body)
      ? "Malformed source-run tracking reached the dead-letter Queue"
      : "Untracked ingest message exhausted primary Queue retries",
  );
}

async function consumeDeadLetterMessage(message: Message<IngestMessage>, env: Env, queueName: string): Promise<void> {
  const tracked = tracking(message.body);
  try {
    await persistDeadLetterMessageToD1(message, env, queueName);
    message.ack();
  } catch (error) {
    console.error(JSON.stringify({
      message: "Ingest dead-letter persistence failed",
      queueMessageId: message.id,
      sourceId: message.body.sourceId,
      sourceRunId: tracked?.runId ?? null,
      attempts: message.attempts,
      error: errorText(error),
    }));
    message.retry({ delaySeconds: 30 });
  }
}

async function consumeQuarantineMessage(message: Message<IngestMessage>, env: Env, queueName: string): Promise<void> {
  let d1Error: unknown;
  try {
    await persistDeadLetterMessageToD1(message, env, queueName);
    message.ack();
    return;
  } catch (error) {
    d1Error = error;
  }

  try {
    const incident = await persistEmergencyQuarantineRecovery(env, message, queueName);
    console.error(JSON.stringify({
      message: "Ingest quarantine used emergency private R2 recovery",
      incidentId: incident.id,
      disposition: incident.disposition,
      attempts: message.attempts,
      d1Error: errorText(d1Error),
    }));
    message.ack();
  } catch (r2Error) {
    console.error(JSON.stringify({
      message: "Ingest quarantine could not persist to D1 or private R2",
      queueMessageId: message.id,
      attempts: message.attempts,
      d1Error: errorText(d1Error),
      r2Error: errorText(r2Error),
    }));
    message.retry({ delaySeconds: 3_600 });
  }
}

export async function handleIngestQueueBatch(batch: MessageBatch<IngestMessage>, env: Env): Promise<void> {
  if (batch.queue === env.INGEST_QUARANTINE_NAME) {
    for (const message of batch.messages) await consumeQuarantineMessage(message, env, batch.queue);
    return;
  }
  if (batch.queue === env.INGEST_DLQ_NAME) {
    for (const message of batch.messages) await consumeDeadLetterMessage(message, env, batch.queue);
    return;
  }
  if (batch.queue !== env.INGEST_QUEUE_NAME) {
    console.error(JSON.stringify({ message: "Unexpected Queue consumer binding", queue: batch.queue }));
    batch.retryAll({ delaySeconds: 30 });
    return;
  }
  for (const message of batch.messages) await consumePrimaryMessage(message, env);
}
