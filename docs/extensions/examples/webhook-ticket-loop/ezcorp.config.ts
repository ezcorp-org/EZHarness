// webhook-ticket-loop — the reference WEBHOOK-triggered Loop example
// (Loops EZ Mode Phase 4).
//
// Fires off an inbound `POST /api/hooks/webhook-ticket-loop/tickets`: an
// external ticketing system posts a ticket; a deterministic `check` gates on
// the (UNTRUSTED) payload's priority; `act` records the accepted ticket. The
// webhook body is attacker-controllable, so this loop is permanently
// `untrusted-input` — autopilot is never offered (Phase 8), and the payload
// reaches check/act only inside the delimited `WebhookInput` wrapper.

import { defineExtension } from "../../../../src/extensions/sdk/define";

export default defineExtension({
  schemaVersion: 2,
  name: "webhook-ticket-loop",
  version: "1.0.0",
  description:
    "Reference webhook-triggered Loop example — an external system POSTs a ticket to a per-hook URL; a deterministic check gates on the untrusted payload's priority and act records it, built on defineLoop.",
  author: { name: "EZCorp" },
  entrypoint: "./index.ts",
  category: "Examples",
  tags: ["loop", "example", "webhook", "reference"],
  // Webhook-only loop — stay resident so a delivery isn't dropped on idle.
  persistent: true,

  settings: {
    enabled: {
      type: "boolean",
      label: "Enabled",
      description: "Process inbound ticket webhooks.",
      default: true,
    },
    // snake_case (validateManifestV2 requires /^[a-z][a-z0-9_]*$/).
    min_priority: {
      type: "select",
      label: "Minimum priority to act on",
      description: "Only fire the AI process for tickets at or above this priority.",
      options: [
        { value: "low", label: "Low" },
        { value: "medium", label: "Medium" },
        { value: "high", label: "High" },
      ],
      default: "high",
    },
  },

  permissions: {
    // The manifest-declared hook slug — the host mints a per-hook secret for it
    // at install and routes an authenticated POST onto the loop delivery queue.
    webhooks: ["tickets"],
    storage: true,
    // The artifact mirror lands under .ezcorp/extension-data/ticket-webhook/.
    filesystem: ["$CWD"],
  },

  resources: { memory: "128MB" },
});
