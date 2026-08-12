export const MAX_CDP_MESSAGE_BYTES = 16_000_000;
export const MAX_KITESURF_TEXT_BYTES = 3_000_000;
export const MAX_KITESURF_HTML_BYTES = 1_000_000;
export const MAX_KITESURF_LINKS = 100;

function stringExceedsUtf8Bytes(value: string, maxBytes: number): boolean {
  let bytes = 0;
  for (let index = 0; index < value.length; index += 1) {
    const codePoint = value.codePointAt(index)!;
    bytes += codePoint <= 0x7f ? 1 : codePoint <= 0x7ff ? 2 : codePoint <= 0xffff ? 3 : 4;
    if (bytes > maxBytes) return true;
    if (codePoint > 0xffff) index += 1;
  }
  return false;
}

/** Validates the actual CDP frame size before the far more expensive JSON parse. */
export function cdpMessageText(data: unknown, maxBytes = MAX_CDP_MESSAGE_BYTES): string {
  if (typeof data === "string") {
    if (stringExceedsUtf8Bytes(data, maxBytes)) throw new Error(`Kitesurf CDP message exceeds ${maxBytes} bytes`);
    return data;
  }
  if (data instanceof ArrayBuffer) {
    if (data.byteLength > maxBytes) throw new Error(`Kitesurf CDP message exceeds ${maxBytes} bytes`);
    return new TextDecoder().decode(data);
  }
  if (ArrayBuffer.isView(data)) {
    if (data.byteLength > maxBytes) throw new Error(`Kitesurf CDP message exceeds ${maxBytes} bytes`);
    return new TextDecoder().decode(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
  }
  throw new Error("Kitesurf CDP returned an unsupported message body");
}

/** Builds a browser-side extraction that clips every returned field before CDP serialization. */
export function kitesurfExtractionExpression(selector: string | undefined, includeLinks: boolean): string {
  const selectorLiteral = JSON.stringify(selector?.trim() || "");
  return `(() => {
    const selector = ${selectorLiteral};
    const includeLinks = ${includeLinks ? "true" : "false"};
    const clipUtf8 = (input, maxBytes) => {
      const original = String(input ?? "");
      const candidate = original.slice(0, maxBytes);
      const encoded = new TextEncoder().encode(candidate);
      if (encoded.byteLength <= maxBytes) {
        return { value: candidate, truncated: candidate.length < original.length };
      }
      let end = maxBytes;
      while (end > 0 && (encoded[end] & 0xc0) === 0x80) end -= 1;
      return { value: new TextDecoder().decode(encoded.subarray(0, end)), truncated: true };
    };
    const root = selector ? document.querySelector(selector) : document.documentElement;
    const textRoot = selector ? root : document.body;
    const title = clipUtf8(document.title || "", 8000);
    const finalUrl = clipUtf8(location.href, 8000);
    const html = clipUtf8(root ? (root.outerHTML || root.innerHTML || "") : "", ${MAX_KITESURF_HTML_BYTES});
    const text = clipUtf8(textRoot ? (textRoot.innerText || textRoot.textContent || "") : "", ${MAX_KITESURF_TEXT_BYTES});
    const links = [];
    let linksTruncated = false;
    if (includeLinks) {
      const anchors = document.querySelectorAll("a[href]");
      linksTruncated = anchors.length > ${MAX_KITESURF_LINKS};
      for (let index = 0; index < anchors.length && links.length < ${MAX_KITESURF_LINKS}; index += 1) {
        const anchor = anchors[index];
        const url = clipUtf8(anchor.href || "", 4096);
        const label = clipUtf8((anchor.innerText || anchor.textContent || anchor.getAttribute("aria-label") || "").replace(/\\s+/g, " ").trim(), 1024);
        links.push({ url: url.value, text: label.value });
        linksTruncated = linksTruncated || url.truncated || label.truncated;
      }
    }
    return {
      title: title.value,
      finalUrl: finalUrl.value,
      html: html.value,
      text: text.value,
      links,
      truncated: title.truncated || finalUrl.truncated || html.truncated || text.truncated || linksTruncated
    };
  })()`;
}

export function cdpEvaluationValue(reply: Record<string, unknown>): unknown {
  if (reply.exceptionDetails) throw new Error("Kitesurf page evaluation failed");
  return (reply.result as Record<string, unknown> | undefined)?.value;
}

export function cdpEvaluationObject(reply: Record<string, unknown>): Record<string, unknown> {
  const value = cdpEvaluationValue(reply);
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}
