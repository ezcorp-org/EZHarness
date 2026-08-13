import { defineExtension } from "../../../../src/extensions/sdk/define";

export default defineExtension({
  schemaVersion: 2,
  name: "time-teller",
  version: "0.1.0",
  description:
    "Gets the current time in an IANA timezone and renders a live analog wall clock with a digital date and time readout.",
  author: { name: "EZCorp" },
  entrypoint: "./index.ts",
  category: "Utilities",
  tags: ["time", "clock", "timezone", "wall-clock", "ui"],

  tools: [
    {
      name: "tell-time",
      description:
        "Get the current time and render a live wall clock. Use an IANA timezone such as " +
        "'UTC', 'America/New_York', 'Europe/London', or 'Asia/Tokyo'. If the user " +
        "does not name a timezone, omit it to use UTC. Call once; the rendered clock " +
        "continues updating every second in the browser.",
      suggestExamples: [
        "what time is it right now?",
        "show me a wall clock for Tokyo",
        "what is the current time in New York?",
      ],
      inputSchema: {
        type: "object",
        properties: {
          timezone: {
            type: "string",
            description:
              "Optional IANA timezone, for example 'UTC', 'America/New_York', or 'Asia/Tokyo'. Defaults to UTC.",
          },
          locale: {
            type: "string",
            description:
              "Optional BCP 47 locale used for labels, for example 'en-US', 'en-GB', or 'ja-JP'. Defaults to en-US.",
          },
          hour12: {
            type: "boolean",
            description:
              "Use a 12-hour digital readout when true or a 24-hour readout when false. The locale default is used when omitted.",
          },
        },
      },
      cardType: "time-clock",
    },
  ],

  agent: {
    prompt: [
      "You can display the current time with `tell-time`.",
      "Use an IANA timezone when the user names a city or region; infer the canonical",
      "timezone only when it is unambiguous. If no timezone is given, omit it so the",
      "tool clearly defaults to UTC. Call the tool once: its wall clock updates live",
      "every second in the browser. After it returns, respond with at most one short",
      "sentence because the clock card already shows the answer.",
    ].join("\n"),
    category: "Utilities",
    capabilities: ["current-time", "timezone-conversion", "wall-clock"],
  },

  smokeTest: {
    tool: "tell-time",
    input: { timezone: "UTC", locale: "en-US", hour12: false },
    expect: { isError: false, textIncludes: "time-clock" },
  },

  permissions: {},

  resources: {
    memory: "64MB",
    callTimeoutMs: 5_000,
  },
});
