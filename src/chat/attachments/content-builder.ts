/**
 * Build a pi-ai UserMessage.content payload from the user's typed text plus
 * any persisted attachments, applying per-attachment delivery strategies and
 * enforcing model-capability compatibility.
 *
 * pi-ai natively carries only TextContent and ImageContent parts. Non-image
 * rich kinds (PDF today; more later) are bridged into TextContent with a
 * stable <file> wrapper so the assistant can reference them by filename.
 */

import type { AttachmentCapabilities } from "../../providers/model-capabilities";
import { classifyMimeWithCaps, isMimeAccepted } from "../../providers/model-capabilities";
import { readAttachmentBytes } from "./storage";
import { extractPdfText } from "./pdf-extract";

export interface StagedAttachment {
  /** message_attachments row id. Used as the payload of the
   *  `ez-attachment://<id>` handle that the executor resolves to a real
   *  data URI at tool-call dispatch time. */
  id: string;
  filename: string;
  mimeType: string;
  storagePath: string;
}

/** URI scheme used for symbolic attachment references in LLM-visible text.
 *  The executor substitutes these with `data:<mime>;base64,<bytes>` when
 *  dispatching tool calls whose args contain them. */
export const ATTACHMENT_HANDLE_SCHEME = "ez-attachment://";

export function attachmentHandle(id: string): string {
  return `${ATTACHMENT_HANDLE_SCHEME}${id}`;
}

export type TextContent = { type: "text"; text: string };
export type ImageContent = { type: "image"; data: string; mimeType: string };
export type PiContentPart = TextContent | ImageContent;

export class UnsupportedAttachmentError extends Error {
  readonly code = "UNSUPPORTED_ATTACHMENT" as const;
  readonly filename: string;
  readonly mimeType: string;
  constructor(filename: string, mimeType: string) {
    super(`Attachment ${filename} (${mimeType}) is not supported by the selected model`);
    this.filename = filename;
    this.mimeType = mimeType;
  }
}

function fileWrapper(filename: string, mimeType: string, body: string): string {
  const safeName = filename.replace(/"/g, "'");
  return `<file name="${safeName}" type="${mimeType}">\n${body}\n</file>`;
}

function toBase64(bytes: Uint8Array): string {
  // Bun's Buffer handles large arrays without apply-stack overflow.
  return Buffer.from(bytes).toString("base64");
}

export async function buildUserContent(
  text: string,
  attachments: StagedAttachment[],
  caps: AttachmentCapabilities,
): Promise<PiContentPart[] | string> {
  if (attachments.length === 0) return text;

  const parts: PiContentPart[] = [];
  if (text.trim().length > 0) parts.push({ type: "text", text });

  // Images get double delivery: the native ImageContent (so the model can
  // see them) AND a trailing text block listing each as a short opaque
  // handle (`ez-attachment://<id>`). The executor resolves the handle to
  // a real `data:` URI when dispatching tool calls whose args carry it.
  // This keeps context tiny — the raw bytes are NOT duplicated in text.
  const imageRefs: Array<{ filename: string; mimeType: string; handle: string }> = [];

  for (const att of attachments) {
    if (!isMimeAccepted(caps, att.mimeType)) {
      throw new UnsupportedAttachmentError(att.filename, att.mimeType);
    }
    const kind = classifyMimeWithCaps(caps, att.mimeType);
    if (!kind) throw new UnsupportedAttachmentError(att.filename, att.mimeType);
    const strategy = caps.deliveryFor[kind];
    if (!strategy) throw new UnsupportedAttachmentError(att.filename, att.mimeType);

    if (strategy === "native-image") {
      const bytes = await readAttachmentBytes(att.storagePath);
      parts.push({ type: "image", data: toBase64(bytes), mimeType: att.mimeType });
      imageRefs.push({
        filename: att.filename,
        mimeType: att.mimeType,
        handle: attachmentHandle(att.id),
      });
    } else if (strategy === "text-inline") {
      const bytes = await readAttachmentBytes(att.storagePath);
      const body = new TextDecoder("utf-8").decode(bytes);
      parts.push({ type: "text", text: fileWrapper(att.filename, att.mimeType, body) });
    } else if (strategy === "pdf-text-extract") {
      const bytes = await readAttachmentBytes(att.storagePath);
      const { text: extracted } = await extractPdfText(bytes);
      parts.push({ type: "text", text: fileWrapper(att.filename, att.mimeType, extracted) });
    } else if (strategy === "extension-handle-only") {
      // Bytes are NOT read here. The extension's tools accept the handle
      // as a tool-call argument; the runtime handle-resolver substitutes
      // it to a `data:<mime>;base64,...` URI just before dispatch.
      const body = `Attachment available via extension tools.\nHandle: ${attachmentHandle(att.id)}\nMIME: ${att.mimeType}`;
      parts.push({ type: "text", text: fileWrapper(att.filename, att.mimeType, body) });
    } else {
      // audio-native not wired yet; guard by capability table ensures we never
      // reach here in Phase 1.
      throw new UnsupportedAttachmentError(att.filename, att.mimeType);
    }
  }

  if (imageRefs.length > 0) {
    const entries = imageRefs
      .map((r, i) => {
        const safeName = r.filename.replace(/"/g, "'");
        return `<attachment index="${i + 1}" filename="${safeName}" mimeType="${r.mimeType}" handle="${r.handle}" />`;
      })
      .join("\n");
    parts.push({
      type: "text",
      text:
        "The images above can be passed to tools that accept image URIs by " +
        "using their `handle` value verbatim (e.g. as an entry in an `images: [...]` " +
        "argument). The runtime resolves each handle to the actual image bytes at " +
        "tool-call time — you do not need to download or encode anything yourself.\n\n" +
        entries,
    });
  }

  return parts;
}
