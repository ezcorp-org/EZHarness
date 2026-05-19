/**
 * Periodic, visibility-aware ping that lets the server rotate the session JWT
 * during quiet moments. Pairs with the sliding-refresh logic in
 * `hooks.server.ts` and the previous-token grace window
 * (`web/src/lib/server/auth/session-cookie.ts`) to keep refreshes invisible.
 *
 * Returns a cleanup function. Mount once from the authenticated layout.
 */
const KEEPALIVE_INTERVAL_MS = 20 * 60 * 1000;

export function startAuthKeepalive(): () => void {
  if (typeof window === "undefined") return () => {};

  const tick = () => {
    if (document.visibilityState !== "visible") return;
    fetch("/api/auth/ping", { credentials: "same-origin", cache: "no-store" })
      .catch(() => {
        // Silent: a transient ping failure is benign — the next user nav
        // will retry through the regular hooks path. Hard 401s surface
        // there too, so we don't double-handle them here.
      });
  };

  const intervalId = window.setInterval(tick, KEEPALIVE_INTERVAL_MS);
  // Visibility changes deliberately do NOT trigger an extra fetch. If a tab
  // sits in the background past the interval, the next visible tick will
  // catch it. Firing on every visibilityChange would amplify request volume
  // for users who flip tabs constantly.

  return () => {
    window.clearInterval(intervalId);
  };
}
