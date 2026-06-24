// ping-loop — a watchable, LLM-free Loop SDK demo manifest.
//
// A MANUAL-trigger + dashboard loop: a human clicks "Ping now" on the Hub
// page and a fresh "done" run row appears. There is NO LLM, NO chat, and NO
// network — every fire is deterministic (seq + the injected fire timestamp),
// so the demo is flake-free and reproducible.
//
// Declares exactly what a manual+dashboard loop needs: storage (the run
// store), a filesystem path for the artifact mirror, the Hub page, the
// manual tool the dashboard button fires, and the `ping-loop:run` page-action
// event the button dispatches.

import { defineExtension } from "../../../../src/extensions/sdk/define";

export default defineExtension({
  schemaVersion: 2,
  name: "ping-loop",
  version: "1.0.0",
  description:
    "Watchable Loop SDK demo — click 'Ping now' on the Hub dashboard to fire a deterministic, LLM-free loop and watch 'done' run rows appear, built on defineLoop.",
  author: { name: "EZCorp" },
  entrypoint: "./index.ts",
  category: "Examples",
  tags: ["loop", "example", "demo"],
  // Manual/page-action loop — must stay resident to receive `ping-loop:run`
  // page-action dispatches from the Hub button (no idle eviction).
  persistent: true,

  // Hub page declaration (Extension Pages Hub). Declaring the page IS the
  // grant — the "Ping Loop" dashboard tab appears at
  // /hub/ext:ping-loop:dashboard once the extension is enabled.
  pages: [
    {
      id: "dashboard",
      title: "Ping Loop",
      icon: "Activity",
      description:
        "Click 'Ping now' to fire the loop. Each fire appends a deterministic 'done' run row (seq + message), refreshed live via pushPage.",
    },
  ],

  permissions: {
    // The run store (one key per run + an index) lives in Storage.
    storage: true,
    // The artifact mirror lands under .ezcorp/extension-data/ping/.
    filesystem: ["$CWD"],
    // The dashboard button dispatches the `ping-loop:run` page action; the
    // page-tree validator drops any action node naming an undeclared event,
    // so the button's action.event must be listed here. The event is prefixed
    // with the EXTENSION name (`ping-loop:`) — the Hub dispatcher requires it.
    eventSubscriptions: ["ping-loop:run"],
    // NO llm / network / shell / spawnAgents — this demo is fully local and
    // deterministic.
  },

  resources: { memory: "128MB" },
});
