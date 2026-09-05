export const EXTENSION_DOCUMENT_CSP = "sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; font-src data:; img-src data: blob:; connect-src 'none'; frame-ancestors 'self'; base-uri 'none'; form-action 'none'";

export function extensionDocumentHeaders(): Record<string, string> {
  return { "Content-Type": "text/html; charset=utf-8", "Content-Security-Policy": EXTENSION_DOCUMENT_CSP, "X-Content-Type-Options": "nosniff", "Cache-Control": "private, no-store", "Referrer-Policy": "no-referrer", "Permissions-Policy": "camera=(), microphone=(), geolocation=()" };
}
