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
        "Scaffold a new EZCorp extension and create a draft. Returns { draftId, openUrl, name, type }.\n\nSUPPORTED TYPES: tool, skill, agent, multi (see docs/extensions/AUTHORING.md for the contract of each).\n\nIMPORTANT — env-key-leak install gate: do NOT declare any env name matching /(_API_KEY|TOKEN|SECRET)$/i in `permissions.env`. The install will be REFUSED. If the user needs an API credential, take it as a tool input parameter instead.\n\nREAD docs/extensions/AUTHORING.md for the full authoring contract before invoking this tool.\n\nWORKFLOW — this is STEP 1 of a fixed 3-step chain: create_extension → validate_extension → install_draft. After this returns successfully you MUST proceed to validate_extension, then install_draft, in the SAME turn, WITHOUT waiting for further user prompting — UNLESS the user explicitly said \"draft only\" / \"don't install yet\". Do NOT end your turn after only scaffolding; a scaffolded-but-uninstalled draft is an incomplete request.",
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
        "Run the host's canonical acceptance gate against a draft (loadManifest → validateManifestV2 → required smokeTest round-trip for tool/multi). Returns { ok: boolean, pass: boolean, steps: [{ name, ok, detail }] }.\n\nWORKFLOW — STEP 2 of 3. On { ok:true } you MUST immediately call install_draft in the SAME turn. On { ok:false } read the failing `steps`, fix them with write_draft_file, and re-run this tool — never finish your turn with a draft that has not passed.",
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
        "Install a validated draft as a real, ENABLED extension so it can be tested immediately and appears in the user's Extensions/Library tab. Runs the same secure pipeline as the web install form (verifyExtension smoke-test hard-gate for tool/multi, env-key-leak gate).\n\nWORKFLOW — STEP 3 of 3 and the REQUIRED terminal step of every authoring request: always call this after a passing validate_extension. This call ALWAYS surfaces a one-time permission card the user must Allow — that is the expected, by-design security gate. Do NOT ask the user for permission yourself beforehand; just call the tool and let the card collect consent. On Deny, nothing is installed: report that and stop — do NOT retry on Deny.\n\nRESULT — on success: { ok:true, extensionId, name, openUrl }. On failure: { ok:false, code, error }. Branch DETERMINISTICALLY on `code`:\n• VERIFY_FAILED — read `error`, fix the draft with write_draft_file, then re-run validate_extension and install_draft.\n• ENV_KEY_LEAK — an env name matched the install gate; move that credential to a tool INPUT parameter (see create_extension's env guidance), rewrite with write_draft_file, then re-validate and re-install.\n• NAME_COLLISION — STOP. Do NOT rename, add a numeric suffix, or retry automatically. Tell the user that name is already installed and ask them to choose: (a) pick a different name, (b) uninstall/discard the existing extension first, or (c) cancel — then WAIT for their decision before doing anything else.",
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
    {
      name: "modify_extension",
      description:
        "Re-open an ALREADY-INSTALLED extension that the USER created so it can be edited and re-installed. Use this (NOT create_extension) when the user asks to change/fix/update an existing extension of theirs.\n\nELIGIBILITY (host-enforced): only an extension the requesting user created AND that an admin has flagged `modifiable` AND that is not bundled can be re-opened. The user cannot self-enable this — only an admin can. If this returns { ok:false, code:\"NOT_FOUND_OR_NOT_MODIFIABLE\" }: STOP — do not retry, do not fall back to create_extension. Tell the user that an admin must open THIS extension's detail page (Library → click the extension), go to the \"Settings\" section, and turn ON the \"Allow extension to be modified\" checkbox; built-in/bundled extensions can never be made modifiable. Then stop and wait — do not proceed until they confirm it's enabled.\n\nThis call ALWAYS surfaces a one-time permission card the user must Allow (the by-design \"the assistant can't silently rewrite my extension\" gate). Do NOT ask for permission yourself first; call the tool and let the card collect consent. On Deny: report it and stop.\n\nWORKFLOW — on success returns { ok:true, draftId, name }. Then continue IN THE SAME TURN: read_draft(draftId) to see current files → apply the user's change with write_draft_file → validate_extension(draftId) → install_draft(draftId). The re-install is a SANCTIONED IN-PLACE upgrade of the existing extension — it will NOT raise NAME_COLLISION for the same name (that is expected; do not treat the unchanged name as a problem).",
      inputSchema: {
        type: "object",
        properties: {
          name: {
            type: "string",
            description:
              "The installed extension's manifest name (or id) to re-open for editing.",
          },
        },
        required: ["name"],
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
