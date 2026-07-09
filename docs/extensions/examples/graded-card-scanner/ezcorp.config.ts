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

  agent: {
    prompt: [
      "You can look up PSA-graded cards by cert number with `lookup_card`.",
      "It returns identity, population per grade, and price per grade as",
      "JSON; null means the source had no value (report it as N/A, never 0).",
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
    // PSA official API (identity + population, free-tier token) and
    // PriceCharting (keyless prices). The free-tier PSA token is supplied
    // at runtime via the `set_psa_token` tool (encrypted extension secret),
    // so no credential-shaped `env` grant is declared.
    network: ["api.psacard.com", "www.pricecharting.com"],
  },

  resources: {
    memory: "256MB",
    callTimeoutMs: 30_000,
  },
});
