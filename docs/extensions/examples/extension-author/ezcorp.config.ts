import { defineExtension } from "../../../../src/extensions/sdk/define";

// extension-author — bundled extension that lets the in-app LLM author
// new EZCorp extensions on user request. Ships v1 alongside a single
// reverse-RPC `ezcorp/drafts` (bundled-only, gated by
// `BUNDLED_DRAFTS_ALLOWLIST` in `src/extensions/drafts-handler.ts`)
// and a thin web route at `/extensions/author?prefill=<draftId>` that
// renders an editable preview before install.
//
// Permissions are minimal: filesystem under
// `$CWD/.ezcorp/extension-data/extension-author/` ONLY (drafts live
// here as `drafts/<draftId>/<file>`), and `custom.drafts.kinds:
// ["extension"]` to authorize the `ezcorp/drafts` RPC. No network, no
// shell, no env, no storage. The scaffold output the LLM produces
// rides through the same `installFromLocal` path as a CLI
// `ext:install` — env-key-leak gate runs strict (isBundled: false on
// install).

export default defineExtension({
  schemaVersion: 2,
  name: "extension-author",
  version: "0.1.0",
  description:
    "Scaffold, preview, and install new EZCorp extensions from inside a chat. Pairs with the editable preview page at /extensions/author?prefill=<draftId>.",
  author: { name: "EZCorp" },
  entrypoint: "./index.ts",
  persistent: false,
  tools: [
    {
      name: "create_extension",
      description:
        "Scaffold a new EZCorp extension and create a proposal-card draft for the user to review and install. Returns { draftId, openUrl, name, type } — the host's tool-result card renders openUrl as a one-button \"Open prefilled form\".\n\nSUPPORTED TYPES: tool, skill, agent, multi (see docs/extensions/AUTHORING.md for the contract of each).\n\nIMPORTANT — env-key-leak install gate: do NOT declare any env name matching /(_API_KEY|TOKEN|SECRET)$/i in `permissions.env`. The install will be REFUSED. If the user needs an API credential, take it as a tool input parameter instead.\n\nREAD docs/extensions/AUTHORING.md for the full authoring contract before invoking this tool.",
      inputSchema: {
        type: "object",
        properties: {
          name: {
            type: "string",
            description:
              "Lowercase, dotted/dashed/underscored identifier (regex /^[a-z0-9][a-z0-9-_.]{0,63}$/). Must NOT contain '..' segments.",
          },
          type: {
            type: "string",
            enum: ["tool", "skill", "agent", "multi"],
            description:
              "Extension type: tool=JSON-RPC tool server, skill=prompt+knowledge, agent=conversational persona, multi=combination.",
          },
          description: {
            type: "string",
            description:
              "One-paragraph human-readable description. Surfaces in the install card and the marketplace.",
          },
        },
        required: ["name", "type", "description"],
      },
    },
    {
      name: "validate_extension",
      description:
        "Run validateManifestV2 against a draft's ezcorp.config.ts. Optional pre-install sanity check. Returns { ok: boolean, errors: string[] }.",
      inputSchema: {
        type: "object",
        properties: {
          draftId: { type: "string", description: "The draft id returned by create_extension." },
        },
        required: ["draftId"],
      },
    },
    {
      name: "list_drafts",
      description:
        "List the calling user's active extension-author drafts. Returns { drafts: [{ draftId, name, type, createdAt }] }. Each row's draftDir is owned by this extension (no cross-user leak).",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "read_draft",
      description:
        "Return the full file map of a draft's directory. Useful for the LLM to inspect the scaffold before recommending an edit.",
      inputSchema: {
        type: "object",
        properties: {
          draftId: { type: "string", description: "The draft id returned by create_extension." },
        },
        required: ["draftId"],
      },
    },
    {
      name: "write_draft_file",
      description:
        "Patch a single file in a draft's directory. Path-allowlist enforced: only the scaffolder's known file keys (ezcorp.config.ts, index.ts, index.test.ts, README.md, package.json, tsconfig.json, .gitignore) are writable. '..' segments and absolute paths are rejected.",
      inputSchema: {
        type: "object",
        properties: {
          draftId: { type: "string" },
          path: {
            type: "string",
            description:
              "Relative path within the draft dir. Must match a scaffolder file key.",
          },
          content: { type: "string" },
        },
        required: ["draftId", "path", "content"],
      },
    },
    {
      name: "discard_draft",
      description:
        "Delete a draft's directory and mark its ez_drafts row consumed. Idempotent.",
      inputSchema: {
        type: "object",
        properties: {
          draftId: { type: "string" },
        },
        required: ["draftId"],
      },
    },
    {
      name: "install_draft",
      // `cardType: "ez-install"` routes the result through the host's
      // ToolCardRouter to EzToolResultCard, which renders the
      // host-revalidated `openUrl` (`/extensions/<name>`) as a one-click
      // "Open extension" link. Without it the result falls through to
      // DefaultCard (raw JSON) and the deep-link is never surfaced.
      cardType: "ez-install",
      description:
        "Install a validated draft as a real, ENABLED extension so it can be tested immediately. REQUIRES explicit in-chat user approval every time — invoking this tool surfaces a permission card the user must Allow; on Deny nothing is installed. Runs the same secure pipeline as the web install form (verifyExtension smoke-test hard-gate for tool/multi, env-key-leak gate). Call validate_extension first; only call this when the user asked to install/test the extension. Returns { ok, extensionId, name }.",
      inputSchema: {
        type: "object",
        properties: {
          draftId: {
            type: "string",
            description: "The draft id returned by create_extension.",
          },
        },
        required: ["draftId"],
      },
    },
  ],
  permissions: {
    filesystem: ["$CWD/.ezcorp/extension-data/extension-author"],
    custom: { drafts: { kinds: ["extension"] } },
    // No network, no shell, no env, no storage. The reverse-RPC
    // `ezcorp/drafts` is the only host capability the extension needs
    // beyond filesystem.
  },
});
