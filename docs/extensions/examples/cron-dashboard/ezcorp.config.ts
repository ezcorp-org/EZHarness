import { defineExtension } from "../../../../src/extensions/sdk/define";

export default defineExtension({
  schemaVersion: 2,
  name: "cron-dashboard",
  version: "0.1.0",
  description:
    "Reference Hub-page extension: a dashboard tab that visualizes this extension's own scheduled heartbeat runs — stats, a run table, and a clear-log action — refreshed live via pushPage after every fire.",
  author: { name: "EZCorp" },
  entrypoint: "./index.ts",
  category: "Development",
  tags: ["hub", "pages", "cron", "demo"],

  // Hub page declaration (Extension Pages Hub). Declaring the page IS
  // the grant — the tab appears at /hub/ext:cron-dashboard:dashboard
  // once the extension is enabled. Note the verified v1 gap: extensions
  // can NOT read `extension_schedules` through the SDK, so this example
  // self-tracks its run history in `Storage` instead.
  pages: [
    {
      id: "dashboard",
      title: "Cron Dashboard",
      icon: "Clock",
      description: "Scheduled-run history for this extension's heartbeat cron.",
    },
  ],

  permissions: {
    storage: true,
    // The dashboard's "Clear log" button POSTs this event through the
    // generic extension events route ({source:"hub"} body shape). Page
    // actions reuse the eventSubscriptions allowlist — the page-tree
    // validator drops any action node naming an undeclared event.
    eventSubscriptions: ["cron-dashboard:clear-log"],
    schedule: {
      crons: ["*/5 * * * *"],
      maxRunsPerDay: 288,
      purpose:
        "Heartbeat run the dashboard visualizes — each fire appends a row to the self-tracked run log and pushes a fresh page tree.",
    },
  },

  resources: {
    memory: "128MB",
  },
});
