// TEMPORARY, UNCOMMITTED: the repo config hardcodes :4173 with
// `reuseExistingServer: !CI`, so a parallel agent's preview server would be
// silently attached to and this run would grade someone else's build. Own
// port, own server, never reused. Deleted before the branch is handed over.
import base from "./playwright.config";
import { defineConfig } from "@playwright/test";

const PORT = 4291;
const url = `http://localhost:${PORT}`;

export default defineConfig({
  ...base,
  use: { ...base.use, baseURL: url },
  webServer: {
    command: `PI_SKIP_INIT=1 bun run build && EZCORP_PREVIEW_APP_HOST=localhost PI_SKIP_INIT=1 bunx --bun vite preview --port ${PORT} --strictPort`,
    url,
    timeout: 240_000,
    reuseExistingServer: false,
  },
});
