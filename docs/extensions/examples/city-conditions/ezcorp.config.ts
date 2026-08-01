import { defineExtension } from "../../../../src/extensions/sdk/define";

// city-conditions — "what is it like in <city> right now?"
//
// One chat tool for the card, three granular tools so the shipped
// `conditions.workflow.yaml` can express the same aggregation as a
// declarative graph (with the weather + air-quality fetches in one
// parallel batch). All four share the helpers in `lib/`.
//
// ── Capability posture ───────────────────────────────────────────────
//
// `network` is the ONLY runtime permission, allowlisted to the three
// keyless Open-Meteo hosts plus the Atlanta NAB-certified station page.
// No shell, filesystem, env, or storage: the extension holds no
// credential and keeps no state, so there is nothing for a compromise to
// reach or leak.
// Because it takes no credential it also never approaches the
// env-key-leak install gate (which refuses any `permissions.env` name
// ending in `_API_KEY` / `TOKEN` / `SECRET`).
//
// `workflows.names: ["conditions"]` is what makes the shipped asset
// TRIGGERABLE from extension code. Shipping the YAML is just an asset;
// firing it is the privileged act, and the grant is clamped to this one
// bare name (the host namespaces it to `city-conditions:conditions`, so
// it can never address another extension's or a host workflow).
export default defineExtension({
  schemaVersion: 2,
  name: "city-conditions",
  version: "0.2.0",
  description:
    "Current time, weather, pollen, and available mold activity for any city, rendered as a " +
    "city-conditions card. Uses Open-Meteo generally and a NAB-certified reporting station in " +
    "the Atlanta metro, with source, timestamp, unit, and honest unavailable reasons. Ships a " +
    "`conditions` workflow that performs the same aggregation as a declarative graph.",
  author: { name: "EZCorp" },
  entrypoint: "./index.ts",
  category: "Utilities",
  tags: ["weather", "pollen", "mold", "allergies", "time", "open-meteo", "workflow", "ui"],

  tools: [
    {
      name: "city_conditions",
      description:
        "Get current local time, weather, pollen, and available mold activity for one city, " +
        "rendered inline as a city-conditions card. Call once per city; the card includes units, " +
        "source provenance, report time, category or per-grain pollen, and a precise unavailable " +
        "reason when no provider covers a health field. Answer with one short summary afterwards.",
      inputSchema: {
        type: "object",
        properties: {
          city: {
            type: "string",
            description: "City or place name to look up, such as 'Austin', 'Tokyo', or 'Paris, TX'.",
          },
          unit: {
            type: "string",
            enum: ["celsius", "fahrenheit"],
            description:
              "Temperature unit the card should display. Readings are always carried in " +
              "celsius; this only selects the display unit. Defaults to celsius.",
          },
        },
        required: ["city"],
      },
      suggestExamples: [
        "what's it like in austin right now",
        "check the pollen count in tokyo today",
        "current weather and allergies for denver",
      ],
      cardType: "city-conditions",
    },
    {
      name: "geocode",
      description:
        "Resolve a city or place name to a single place record (name, admin1, country, " +
        "latitude, longitude, IANA timezone). Step 1 of the `conditions` workflow.",
      inputSchema: {
        type: "object",
        properties: {
          city: { type: "string", description: "City or place name to resolve." },
        },
        required: ["city"],
      },
    },
    {
      name: "current_weather",
      description:
        "Read current weather for a latitude/longitude: temperature and feels-like in celsius, " +
        "humidity, wind in km/h, WMO code with a human label, day/night flag, plus the " +
        "observation timestamp in the place's own timezone.",
      inputSchema: {
        type: "object",
        properties: {
          latitude: { type: "number", description: "Latitude, -90 to 90." },
          longitude: { type: "number", description: "Longitude, -180 to 180." },
        },
        required: ["latitude", "longitude"],
      },
    },
    {
      name: "air_quality",
      description:
        "Read the best available pollen and mold data for a latitude/longitude. In the Atlanta " +
        "metro this uses a NAB-certified reporting station with observed total/category pollen " +
        "and mold activity; elsewhere it uses Open-Meteo's Europe-only modeled pollen coverage. " +
        "Every field includes units, provenance, timestamp, or a precise unavailable reason.",
      inputSchema: {
        type: "object",
        properties: {
          latitude: { type: "number", description: "Latitude, -90 to 90." },
          longitude: { type: "number", description: "Longitude, -180 to 180." },
        },
        required: ["latitude", "longitude"],
      },
    },
  ],

  agent: {
    prompt: [
      "You can look up live conditions for a city with `city_conditions`.",
      "Use it whenever the user names a place and asks about weather, local time, pollen,",
      "mold, or allergies. Call it once per city and follow with one short summary.",
      "Use the card's source, report date, units, and availability state exactly as returned.",
      "A mold activity band is not a numeric spore count; never turn one into a count.",
      "If a health field is unavailable, repeat its provider-specific reason rather than saying zero.",
      "`geocode`, `current_weather` and `air_quality` are granular workflow steps.",
      "Prefer `city_conditions` in chat because it is the tool that renders the card.",
    ].join("\n"),
    category: "Utilities",
    capabilities: ["weather", "pollen", "mold", "allergies", "time"],
  },

  // Deterministic acceptance round-trip: spawn the subprocess, call the
  // chat tool over JSON-RPC, and assert the single most load-bearing
  // decision in this extension — a bad input comes back as a RENDERABLE
  // failure envelope (`isError: false`, `code: BAD_INPUT`), not as an
  // error result that would strand the reason outside the card.
  //
  // Deliberately network-free. Verify runs in a sandbox that may have no
  // egress at all, and an acceptance gate that goes red because a third
  // party is slow is a gate nobody trusts. The three upstream paths are
  // covered instead by `index.test.ts` against an injected fetch.
  smokeTest: {
    tool: "city_conditions",
    input: { city: "" },
    expect: { isError: false, textIncludes: '"code":"BAD_INPUT"' },
  },

  permissions: {
    network: [
      "geocoding-api.open-meteo.com",
      "api.open-meteo.com",
      "air-quality-api.open-meteo.com",
      "www.atlantaallergy.com",
    ],
    workflows: { names: ["conditions"], maxRunsPerHour: 12 },
  },

  resources: {
    memory: "128MB",
    callTimeoutMs: 20_000,
  },
});
