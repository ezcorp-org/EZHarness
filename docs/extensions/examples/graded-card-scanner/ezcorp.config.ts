import { defineExtension } from "../../../../src/extensions/sdk/define";

export default defineExtension({
  schemaVersion: 2,
  name: "graded-card-scanner",
  version: "0.1.0",
  description:
    "Scan PSA graded-card slabs with your phone and see price + population " +
    "by grade. Ships a camera-scanner web app (served from the extension " +
    "data route) that saves every scanned cert to an on-device list, a " +
    "lookup_card tool the app — and the LLM in chat — can call, and a Hub " +
    "dashboard of recent lookups. Live lookups use PSA's official API for " +
    "identity + population (free token supplied via the set_psa_token tool) " +
    "and PriceCharting for prices; missing values are always N/A, never a " +
    "guess.",
  author: { name: "EZCorp" },
  entrypoint: "./index.ts",
  persistent: false,
  category: "Collectibles",
  tags: ["psa", "cards", "scanner", "collectibles", "prices"],

  // Hub dashboard — declaring the page IS the grant; the tab appears at
  // /hub/ext:graded-card-scanner:dashboard once enabled. No actions in
  // v1, so no eventSubscriptions.
  pages: [
    {
      id: "dashboard",
      title: "Card Scanner",
      icon: "ScanBarcode",
      description: "Recent PSA-graded card lookups — value + population by grade.",
    },
  ],

  tools: [
    {
      name: "lookup_card",
      description:
        "Look up a PSA-graded card by its certification number. Returns the " +
        "card's identity (subject, year, set, card number, variety, grade) " +
        "plus population and price per grade as JSON. Missing values are " +
        "null — never zero or a guess. Pass fresh=true to bypass any cache. " +
        "Use when the user gives a PSA cert number or asks what a slab is " +
        "worth.",
      inputSchema: {
        type: "object",
        properties: {
          cert: {
            type: "string",
            description:
              "PSA certification number — 5-10 digits, or a psacard.com/cert " +
              "URL from a slab's QR code.",
          },
          fresh: {
            type: "boolean",
            description: "Bypass the cache and re-fetch current data.",
          },
        },
        required: ["cert"],
      },
    },
    {
      name: "identify_slab",
      description:
        "Identify a graded-card slab from a photo (any grader: PSA, CGC, " +
        "BGS, SGC). Decodes the label barcode/QR host-side, extracts cert " +
        "+ grader, looks up identity (PSA API; CGC public cert page) and " +
        "PriceCharting prices per grading company, and computes the % " +
        "price difference between adjacent grades for each company. " +
        "Missing values are null — never a guess. Pass the image's " +
        "ez-attachment:// handle; the host substitutes the bytes.",
      cardType: "grade-delta-chart",
      inputSchema: {
        type: "object",
        properties: {
          attachment: {
            type: "string",
            description:
              "ez-attachment:// handle of a slab photo on this " +
              "conversation (resolved to a data: URI at dispatch).",
          },
          filename: {
            type: "string",
            description: "Original filename (for labeling only).",
          },
          mimeType: {
            type: "string",
            description: "Image MIME type (image/png or image/jpeg).",
          },
        },
        required: ["attachment"],
      },
    },
    {
      name: "set_psa_token",
      description:
        "Save the user's free PSA API token so lookups can return card " +
        "identity and population. Get one at api.psacard.com. The token is " +
        "stored encrypted and NEVER shown again — do not repeat the token " +
        "back to the user in conversation. Call this when the user provides " +
        "a PSA API token.",
      inputSchema: {
        type: "object",
        properties: {
          token: {
            type: "string",
            description:
              "The user's PSA API access token (10-200 characters). Treat " +
              "as a secret — never echo it back.",
          },
        },
        required: ["token"],
      },
    },
  ],

  // Secret settings — the PSA token can be supplied on the extension's
  // SETTINGS page as well as via the set_psa_token tool. The host writes
  // the value encrypted into extension storage at (scope "user",
  // key "psa-token") — the exact row lib/token.ts's resolveToken already
  // reads — so the scanner needs zero code changes for this path.
  settings: {
    psa_api_token: {
      type: "secret",
      label: "PSA API token",
      description:
        "Free token from api.psacard.com — unlocks card identity and " +
        "population data. Stored encrypted; never shown again.",
      storageKey: "psa-token",
    },
  },

  // Deterministic pre-processing (host feature): when this extension is
  // wired to a conversation and a user message carries a PNG/JPEG
  // attachment, the host runs identify_slab on it automatically — no LLM
  // tool-call needed — persisting a grade-delta-chart card and grounding
  // the reply with the result.
  preprocessors: [
    {
      tool: "identify_slab",
      accepts: ["image/png", "image/jpeg"],
      description: "Identify a graded-card slab photo (PSA/CGC/BGS/SGC).",
    },
  ],

  // Third-party npm packages lib/decode.ts imports to decode the slab
  // barcode/QR host-side. NOT installed by the host — they must exist in
  // the deployment's node_modules (declared in the app's root
  // package.json). The host VERIFIES them at install/activate/boot and
  // before every spawn (see src/extensions/npm-deps.ts); a missing one
  // refuses install + surfaces an actionable message instead of the
  // opaque "Transport closed" crash-loop that auto-disabled this
  // extension on 2026-07-11.
  npmDependencies: {
    "@zxing/library": "^0.23.0",
    "fast-png": "^8.0.0",
    "jpeg-js": "^0.4.4",
  },

  agent: {
    prompt: [
      "You can look up PSA-graded cards by cert number with `lookup_card`.",
      "It returns identity, population per grade, and price per grade as",
      "JSON; null means the source had no value (report it as N/A, never 0).",
      "Slab PHOTOS attached to a message are identified automatically",
      "(deterministic preprocess) — the result card appears in the chat and",
      "the JSON is provided to you as a system note; you can also call",
      "`identify_slab` with an image's ez-attachment:// handle directly.",
      "The user also has a phone scanner page at",
      "`/api/extensions/graded-card-scanner/data/app/index.html` — mention it",
      "if they want continuous scanning rather than one-off lookups.",
    ].join("\n"),
    category: "Collectibles",
    capabilities: ["card-lookup", "price-data"],
  },

  permissions: {
    shell: false,
    storage: true,
    eventSubscriptions: [],
    // PSA official API (identity + population, free-tier token),
    // PriceCharting (keyless prices), and the CGC public cert-lookup
    // pages (multi-grader identity). The free-tier PSA token is supplied
    // at runtime via the `set_psa_token` tool or the extension settings
    // page (both write the same encrypted extension-storage row), so no
    // credential-shaped `env` grant is declared. NOTE: a decoded QR
    // may carry a cgccomics.com URL (lib/classify.ts recognises it), but
    // the actual lookup always fetches www.cgccards.com (lib/sources/cgc.ts
    // HOST) — so that is the ONLY CGC host granted (least privilege).
    network: [
      "api.psacard.com",
      "www.pricecharting.com",
      "www.cgccards.com",
    ],
  },

  resources: {
    memory: "256MB",
    callTimeoutMs: 30_000,
  },
});
