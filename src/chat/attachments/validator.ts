/**
 * Attachment validator: size limit + MIME whitelist + magic-byte sniff.
 *
 * The claimed MIME type from the upload is untrusted. We always sniff the file
 * bytes with `file-type` and, for text files (which file-type can't detect), we
 * accept the claimed MIME only if it is in the text whitelist and the bytes
 * decode as valid UTF-8.
 */

import { fileTypeFromBuffer } from "file-type";
import type { AttachmentCapabilities } from "../../providers/model-capabilities";
import { isMimeAccepted, TEXT_MIMES } from "../../providers/model-capabilities";

export type ValidationFailure =
  | { ok: false; code: "TOO_LARGE"; limit: number; actual: number }
  | { ok: false; code: "MIME_NOT_ALLOWED"; mimeType: string }
  | { ok: false; code: "MIME_MISMATCH"; claimed: string; detected: string | null }
  | { ok: false; code: "NOT_UTF8"; mimeType: string };

export type ValidationSuccess = { ok: true; canonicalMime: string };

export type ValidationResult = ValidationSuccess | ValidationFailure;

export async function validateAttachment(
  bytes: Uint8Array,
  claimedMime: string,
  caps: AttachmentCapabilities,
): Promise<ValidationResult> {
  if (bytes.byteLength > caps.maxBytesPerFile) {
    return { ok: false, code: "TOO_LARGE", limit: caps.maxBytesPerFile, actual: bytes.byteLength };
  }

  if (!isMimeAccepted(caps, claimedMime)) {
    return { ok: false, code: "MIME_NOT_ALLOWED", mimeType: claimedMime };
  }

  // Text MIMEs: file-type can't sniff them, so verify via UTF-8 decode.
  if ((TEXT_MIMES as readonly string[]).includes(claimedMime)) {
    try {
      new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      return { ok: true, canonicalMime: claimedMime };
    } catch {
      return { ok: false, code: "NOT_UTF8", mimeType: claimedMime };
    }
  }

  const detected = await fileTypeFromBuffer(bytes);
  const detectedMime = detected?.mime ?? null;
  if (detectedMime !== claimedMime) {
    return { ok: false, code: "MIME_MISMATCH", claimed: claimedMime, detected: detectedMime };
  }
  return { ok: true, canonicalMime: detectedMime };
}
