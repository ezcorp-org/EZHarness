// @ts-check
// Cert-number extraction — shared by the scanner SPA (browser) and the
// extension subprocess (Bun). Pure functions, no I/O.
//
// Accepted inputs (spec: "digits, or parse it out of the URL"):
//   - a bare PSA cert number: 5–10 digits (modern certs are 8–9; old
//     slabs go shorter — anything outside 5–10 is noise, not a cert)
//   - a psacard.com cert URL (modern slabs' back QR):
//     https://www.psacard.com/cert/49392223[/extra][?query]
// Everything else → null. Never guess.

const BARE_CERT_RE = /^\d{5,10}$/;
const URL_CERT_RE = /psacard\.com\/cert\/(\d{5,10})(?:[/?#]|$)/i;

/**
 * Extract a PSA cert number from a scanned/typed string.
 * @param {unknown} raw decoded barcode/QR text or manual input
 * @returns {string|null} the cert digits, or null if none found
 */
export function parseCertInput(raw) {
  if (typeof raw !== "string") return null;
  const text = raw.trim();
  if (text.length === 0) return null;
  if (BARE_CERT_RE.test(text)) return text;
  const m = URL_CERT_RE.exec(text);
  return m?.[1] ?? null;
}

/**
 * @param {unknown} cert
 * @returns {boolean} true when `cert` is a plausible bare cert number
 */
export function isValidCert(cert) {
  return typeof cert === "string" && BARE_CERT_RE.test(cert);
}
