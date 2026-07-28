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
// `network` is the ONLY runtime permission, allowlisted to exactly the
// three keyless Open-Meteo hosts this extension talks to. No shell, no
// filesystem, no env, no storage: the extension holds no credential and
// keeps no state, so there is nothing for a compromise to reach or leak.
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
  version: "0.1.0",
  description:
    "Current time, weather, and pollen for any city, rendered as a city-conditions card. " +
    "Mold is reported as explicitly unavailable — no keyless provider publishes spore counts, " +
    "and this extension will not invent a health figure. Ships a `conditions` workflow that " +
    "performs the same aggregation as a declarative graph.",
  author: { name: "EZCorp" },
  entrypoint: "./index.ts",
  category: "Utilities",
  tags: ["weather", "pollen", "air-quality", "time", "open-meteo", "workflow", "ui"],

  tools: [
    {
      name: "city_conditions",
      description:
        "Get current local time, weather, and pollen for one city, rendered inline as a " +
        "city-conditions card. Call once per city the user names; the returned card already " +
        "shows the local time, temperature, feels-like, humidity, wind, per-grain pollen with " +
        "a severity band, and an explicit 'mold not available' state — so answer with one " +
        "short summary afterwards instead of calling again.",
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
        "Read current pollen for a latitude/longitude: the six grains Open-Meteo publishes " +
        "(alder, birch, grass, mugwort, olive, ragweed) with a summed index and severity band, " +
        "plus the mold block, which always reports as unavailable with its reason.",
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
      "Use it whenever the user names a place and asks about the weather, the time there,",
      "pollen, or allergies. Call it once per city: the card it returns already shows the",
      "local time, temperature, feels-like, humidity, wind, per-grain pollen and its band,",
      "so follow up with one short summary rather than another call.",
      "Mold always comes back `available: false` with a reason — say so plainly if asked.",
      "Never state a mold count; no keyless provider publishes one.",
      "`geocode`, `current_weather` and `air_quality` are the granular steps the `conditions`",
      "workflow runs. Prefer `city_conditions` in chat — it is the one that renders a card.",
    ].join("\n"),
    category: "Utilities",
    capabilities: ["weather", "pollen", "time"],
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
    ],
    workflows: { names: ["conditions"], maxRunsPerHour: 12 },
  },

  resources: {
    memory: "128MB",
    callTimeoutMs: 20_000,
  },
});
