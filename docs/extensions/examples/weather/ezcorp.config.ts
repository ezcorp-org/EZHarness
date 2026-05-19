import { defineExtension } from "../../../../src/extensions/sdk/define";

export default defineExtension({
  schemaVersion: 2,
  name: "weather",
  version: "0.1.0",
  description:
    "Fetch current weather + a short forecast from Open-Meteo and render it inline with a custom weather web component card.",
  author: { name: "EZCorp" },
  entrypoint: "./index.ts",
  category: "Utilities",
  tags: ["weather", "forecast", "open-meteo", "demo", "ui"],

  tools: [
    {
      name: "get_weather",
      description:
        "Look up current weather and a short forecast for a city or region. " +
        "Call this once per location request; the returned custom weather card " +
        "already includes current conditions, today's high/low, and a 3-day outlook.",
      inputSchema: {
        type: "object",
        properties: {
          location: {
            type: "string",
            description:
              "City, region, or place name to search, such as 'San Francisco', 'Tokyo', or 'Paris, TX'.",
          },
          unit: {
            type: "string",
            enum: ["celsius", "fahrenheit"],
            description: "Temperature unit to display. Defaults to celsius.",
          },
        },
        required: ["location"],
      },
      cardType: "weather-panel",
    },
  ],

  agent: {
    prompt: [
      "You can fetch weather with `get_weather`.",
      "Use it when the user asks for current conditions or a forecast for a place.",
      "Call it once per requested location. The returned card already contains the",
      "current temperature, feels-like, wind, humidity, and a short forecast, so",
      "after the tool returns respond with a brief natural-language summary instead",
      "of repeatedly calling the tool.",
    ].join("\n"),
    category: "Utilities",
    capabilities: ["weather", "forecast"],
  },

  permissions: {
    shell: false,
    eventSubscriptions: [],
    network: ["geocoding-api.open-meteo.com", "api.open-meteo.com"],
  },

  resources: {
    memory: "128MB",
    callTimeoutMs: 20_000,
  },
});
