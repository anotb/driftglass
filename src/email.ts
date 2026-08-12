import {
  claimInboxReceiptDelivery,
  completeInboxReceiptQueueClaim,
  failInboxReceiptQueueClaim,
  recordUnkeyedInboxReceipt,
  upsertSource,
} from "./db";
import { enqueueIngestMessages } from "./ingest-queue";
import type { Env, InboxReceiptRecord, NormalizedItemInput } from "./types";
import { isoNow, stripHtml } from "./utils";

const MAX_EMAIL_BYTES = 2_000_000;
const MAX_MIME_DEPTH = 8;
const MAX_MIME_PARTS = 100;
const MAX_MIME_HEADERS = 200;
const MAX_MIME_HEADER_CHARS = 64_000;
const MAX_ATTACHMENT_METADATA = 20;
const MAX_ATTACHMENT_FILENAME_CHARS = 180;

export interface MimeAttachmentMetadata {
  filename: string | null;
  contentType: string;
  byteSize: number;
}

export interface ParsedMimeMessage {
  text: string;
  html: string;
  headers: Record<string, string>;
  attachments: MimeAttachmentMetadata[];
  attachmentCount: number;
  attachmentsTruncated: boolean;
  partCount: number;
  parsingTruncated: boolean;
}

export interface EmailIntakeOutcome {
  receiptId: string;
  messageId?: string;
  duplicate: boolean;
  queued: boolean;
  deliveryCount: number;
  outcome: InboxReceiptRecord["outcome"];
  queueState: InboxReceiptRecord["queue_state"];
}

function decodeQuotedPrintable(value: string): string {
  const unfolded = value.replace(/=\r?\n/g, "");
  const bytes: number[] = [];
  for (let index = 0; index < unfolded.length; index += 1) {
    if (unfolded[index] === "=" && /^[0-9A-Fa-f]{2}$/.test(unfolded.slice(index + 1, index + 3))) {
      bytes.push(Number.parseInt(unfolded.slice(index + 1, index + 3), 16));
      index += 2;
    } else {
      bytes.push(unfolded.charCodeAt(index));
    }
  }
  return new TextDecoder().decode(new Uint8Array(bytes));
}

function decodeBase64(value: string): string {
  try {
    const clean = value.replace(/\s+/g, "");
    const binary = atob(clean);
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    return new TextDecoder().decode(bytes);
  } catch {
    return value;
  }
}

function decodeEncodedWords(value: string): string {
  return value.replace(/=\?([^?]+)\?([bqBQ])\?([^?]+)\?=/g, (_all, _charset, mode, payload) => {
    if (String(mode).toLowerCase() === "b") return decodeBase64(payload);
    return decodeQuotedPrintable(String(payload).replaceAll("_", " "));
  });
}

function parseHeaders(block: string): Record<string, string> {
  const unfolded = block.replace(/\r?\n[\t ]+/g, " ");
  const headers: Record<string, string> = {};
  for (const line of unfolded.split(/\r?\n/).slice(0, MAX_MIME_HEADERS)) {
    const index = line.indexOf(":");
    if (index < 1) continue;
    const name = line.slice(0, index).trim().toLowerCase().slice(0, 200);
    if (!name) continue;
    headers[name] = decodeEncodedWords(line.slice(index + 1).trim()).slice(0, 8_000);
  }
  return headers;
}

function decodePart(body: string, headers: Record<string, string>): string {
  const transfer = (headers["content-transfer-encoding"] ?? "").toLowerCase();
  if (transfer.includes("base64")) return decodeBase64(body);
  if (transfer.includes("quoted-printable")) return decodeQuotedPrintable(body);
  return body;
}

function headerParameter(value: string, name: string): string | undefined {
  const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = value.match(new RegExp(`(?:^|;)\\s*${escapedName}(\\*)?\\s*=\\s*(?:"((?:\\\\.|[^"])*)"|([^;]*))`, "i"));
  if (!match) return undefined;
  let parameter = (match[2] ?? match[3] ?? "").trim().replace(/\\"/g, "\"");
  if (match[1]) {
    const encoded = parameter.includes("''") ? parameter.slice(parameter.indexOf("''") + 2) : parameter;
    try { parameter = decodeURIComponent(encoded); } catch { parameter = encoded; }
  }
  return decodeEncodedWords(parameter);
}

function normalizedContentType(value: string | undefined): string {
  const contentType = (value ?? "application/octet-stream").split(";", 1)[0]?.trim().toLowerCase() ?? "";
  return /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(contentType)
    ? contentType.slice(0, 120)
    : "application/octet-stream";
}

function attachmentFilename(headers: Record<string, string>): string | null {
  const value = headerParameter(headers["content-disposition"] ?? "", "filename")
    ?? headerParameter(headers["content-type"] ?? "", "name");
  if (!value) return null;
  const clean = value
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replaceAll("\\", "/")
    .split("/")
    .at(-1)
    ?.trim()
    .slice(0, MAX_ATTACHMENT_FILENAME_CHARS);
  return clean || null;
}

function quotedPrintableByteSize(value: string): number {
  let bytes = 0;
  for (let index = 0; index < value.length; index += 1) {
    if (value[index] === "=" && /^\r?\n/.test(value.slice(index + 1, index + 3))) {
      index += value[index + 1] === "\r" ? 2 : 1;
      continue;
    }
    if (value[index] === "=" && /^[0-9A-Fa-f]{2}$/.test(value.slice(index + 1, index + 3))) {
      bytes += 1;
      index += 2;
      continue;
    }
    const codePoint = value.codePointAt(index) ?? 0;
    bytes += codePoint <= 0x7f ? 1 : codePoint <= 0x7ff ? 2 : codePoint <= 0xffff ? 3 : 4;
    if (codePoint > 0xffff) index += 1;
  }
  return bytes;
}

function attachmentByteSize(body: string, transferEncoding: string): number {
  if (transferEncoding.includes("base64")) {
    const compact = body.replace(/\s+/g, "");
    if (/^[A-Za-z0-9+/]*={0,2}$/.test(compact)) {
      const padding = compact.endsWith("==") ? 2 : compact.endsWith("=") ? 1 : 0;
      return Math.max(0, Math.floor(compact.length * 3 / 4) - padding);
    }
  }
  if (transferEncoding.includes("quoted-printable")) return quotedPrintableByteSize(body);
  return new TextEncoder().encode(body).byteLength;
}

interface MimeParseState {
  attachments: MimeAttachmentMetadata[];
  attachmentCount: number;
  partCount: number;
  truncated: boolean;
}

function isAttachmentPart(headers: Record<string, string>, contentType: string, filename: string | null): boolean {
  const disposition = (headers["content-disposition"] ?? "").trim().toLowerCase();
  if (disposition.startsWith("attachment") || filename) return true;
  if (disposition.startsWith("inline") && (Boolean(headers["content-id"]) || !contentType.startsWith("text/"))) return true;
  return !contentType.startsWith("text/") && !contentType.startsWith("multipart/");
}

function parseMimeEntity(
  raw: string,
  depth: number,
  state: MimeParseState,
): { text: string; html: string; headers: Record<string, string> } {
  const split = raw.search(/\r?\n\r?\n/);
  const headerBlock = split >= 0 ? raw.slice(0, Math.min(split, MAX_MIME_HEADER_CHARS)) : "";
  if (split > MAX_MIME_HEADER_CHARS) state.truncated = true;
  const body = split >= 0 ? raw.slice(split).replace(/^\r?\n\r?\n/, "") : raw;
  const headers = parseHeaders(headerBlock);
  const contentTypeHeader = headers["content-type"] ?? "text/plain";
  const contentType = normalizedContentType(contentTypeHeader);
  const filename = attachmentFilename(headers);
  if (isAttachmentPart(headers, contentType, filename)) {
    state.attachmentCount += 1;
    if (state.attachments.length < MAX_ATTACHMENT_METADATA) {
      state.attachments.push({
        filename,
        contentType,
        byteSize: Math.min(MAX_EMAIL_BYTES, attachmentByteSize(body.replace(/\r?\n$/, ""), (headers["content-transfer-encoding"] ?? "").toLowerCase())),
      });
    } else {
      state.truncated = true;
    }
    return { text: "", html: "", headers };
  }

  const boundary = headerParameter(contentTypeHeader, "boundary")?.slice(0, 200);
  if (!boundary) {
    if (!contentType.startsWith("text/")) return { text: "", html: "", headers };
    const decoded = decodePart(body, headers);
    return contentType === "text/html"
      ? { text: stripHtml(decoded), html: decoded, headers }
      : { text: decoded, html: "", headers };
  }

  if (depth >= MAX_MIME_DEPTH) {
    state.truncated = true;
    return { text: "", html: "", headers };
  }

  let text = "";
  let html = "";
  const chunks = body.split(`--${boundary}`).slice(1);
  for (const chunk of chunks) {
    const entity = chunk.replace(/^\r?\n/, "");
    if (entity.startsWith("--")) break;
    if (state.partCount >= MAX_MIME_PARTS) {
      state.truncated = true;
      break;
    }
    state.partCount += 1;
    const nested = parseMimeEntity(entity.replace(/\r?\n$/, ""), depth + 1, state);
    text ||= nested.text;
    html ||= nested.html;
  }
  return { text: text || stripHtml(html), html, headers };
}

export function parseMimeMessage(raw: string): ParsedMimeMessage {
  const state: MimeParseState = { attachments: [], attachmentCount: 0, partCount: 0, truncated: false };
  const parsed = parseMimeEntity(raw.slice(0, MAX_EMAIL_BYTES), 0, state);
  return {
    ...parsed,
    attachments: state.attachments,
    attachmentCount: state.attachmentCount,
    attachmentsTruncated: state.attachmentCount > state.attachments.length,
    partCount: state.partCount,
    parsingTruncated: state.truncated || raw.length > MAX_EMAIL_BYTES,
  };
}

function extractLinks(value: string): string[] {
  const links = new Set<string>();
  for (const match of value.matchAll(/https?:\/\/[^\s<>"')\]]+/gi)) {
    try {
      const url = new URL(match[0].replace(/[.,;:!?]+$/, ""));
      const keys: string[] = [];
      url.searchParams.forEach((_value, key) => keys.push(key));
      for (const key of keys) {
        if (key.toLowerCase().startsWith("utm_") || ["mc_cid", "mc_eid", "ref"].includes(key.toLowerCase())) {
          url.searchParams.delete(key);
        }
      }
      links.add(url.toString());
    } catch {
      // Ignore malformed links in email bodies.
    }
  }
  return [...links].slice(0, 100);
}

async function readRaw(raw: ReadableStream<Uint8Array>, declaredSize: number): Promise<string> {
  if (declaredSize > MAX_EMAIL_BYTES) throw new Error("Email is larger than the 2 MB intake limit");
  const reader = raw.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > MAX_EMAIL_BYTES) throw new Error("Email is larger than the 2 MB intake limit");
    chunks.push(value);
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { merged.set(chunk, offset); offset += chunk.byteLength; }
  return new TextDecoder().decode(merged);
}

function cleanMessageId(value: string | null | undefined): string | undefined {
  const clean = value?.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, 998);
  return clean || undefined;
}

function outcomeFromReceipt(receipt: InboxReceiptRecord, messageId: string | undefined, duplicate: boolean, queued: boolean): EmailIntakeOutcome {
  return {
    receiptId: receipt.id,
    messageId,
    duplicate,
    queued,
    deliveryCount: receipt.delivery_count,
    outcome: receipt.outcome,
    queueState: receipt.queue_state,
  };
}

async function retryReceiptMutation<T>(mutation: () => Promise<T>): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await mutation();
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

export async function handleEmail(message: ForwardableEmailMessage, env: Env): Promise<EmailIntakeOutcome> {
  const receivedAt = isoNow();
  const raw = await readRaw(message.raw, message.rawSize || 0);
  const parsed = parseMimeMessage(raw);
  const subject = decodeEncodedWords(parsed.headers.subject ?? message.headers.get("subject") ?? "Forwarded signal").slice(0, 500);
  const messageId = cleanMessageId(parsed.headers["message-id"] ?? message.headers.get("message-id"));
  const body = (parsed.text || stripHtml(parsed.html)).replace(/\u0000/g, "").trim().slice(0, 500_000);
  const links = extractLinks(`${parsed.html}\n${body}`);
  const sourceId = "email-inbox";
  await upsertSource(env.DB, {
    id: sourceId,
    name: "Email inbox",
    kind: "email",
    config: { address: message.to },
    scheduleMinutes: 10_080,
    weight: 1.45,
  });
  const receiptMetadata = {
    platform: "email",
    provider: "cloudflare-email",
    accessClass: "private",
    sender: message.from,
    recipient: message.to,
    messageId,
    links: links.length,
    attachments: parsed.attachments,
    attachmentCount: parsed.attachmentCount,
    attachmentsTruncated: parsed.attachmentsTruncated,
    mimePartCount: parsed.partCount,
    mimeParsingTruncated: parsed.parsingTruncated,
  };
  const item: NormalizedItemInput = {
    externalId: messageId,
    url: links[0],
    title: subject || `Email from ${message.from}`,
    text: body,
    author: message.from,
    publishedAt: parsed.headers.date,
    observedAt: receivedAt,
    accessClass: "private",
    metadata: {
      platform: "email",
      sender: message.from,
      recipient: message.to,
      messageId,
      links,
      linkCount: links.length,
      contentType: parsed.headers["content-type"] ?? "unknown",
      attachments: parsed.attachments,
      attachmentCount: parsed.attachmentCount,
      attachmentsTruncated: parsed.attachmentsTruncated,
      mimePartCount: parsed.partCount,
      mimeParsingTruncated: parsed.parsingTruncated,
    },
  };

  if (messageId) {
    const claimToken = crypto.randomUUID();
    const claim = await claimInboxReceiptDelivery(env.DB, {
      id: claimToken,
      sourceId,
      messageId,
      sender: message.from,
      recipient: message.to,
      subject,
      receivedAt,
      itemCount: 1,
      metadata: receiptMetadata,
    });
    if (!claim.ownsQueueClaim) {
      if (claim.receipt.queue_state === "pending") {
        throw new Error(`Email ${messageId} already has a pending Queue claim; retry later`);
      }
      return outcomeFromReceipt(claim.receipt, messageId, true, false);
    }

    try {
      await enqueueIngestMessages(env, [{
        sourceId,
        item,
        provider: "cloudflare-email",
        emailReceiptClaim: { messageId, claimToken },
      }]);
    } catch (error) {
      await retryReceiptMutation(() => failInboxReceiptQueueClaim(env.DB, sourceId, messageId, claimToken))
        .catch((receiptError) => console.error("Failed to mark Email Queue claim failed", receiptError));
      throw error;
    }

    const receipt = await retryReceiptMutation(
      () => completeInboxReceiptQueueClaim(env.DB, sourceId, messageId, claimToken),
    );
    return outcomeFromReceipt(receipt, messageId, claim.duplicate, true);
  }

  await enqueueIngestMessages(env, [{ sourceId, item, provider: "cloudflare-email" }]);
  const receipt = await recordUnkeyedInboxReceipt(env.DB, {
    id: crypto.randomUUID(),
    sourceId,
    sender: message.from,
    recipient: message.to,
    subject,
    receivedAt,
    itemCount: 1,
    metadata: receiptMetadata,
  });
  return outcomeFromReceipt(receipt, undefined, false, true);
}
