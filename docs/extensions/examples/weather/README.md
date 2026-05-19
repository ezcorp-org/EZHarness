# weather

A compact example extension that fetches live weather from Open-Meteo and renders the result inline with a custom web component card.

## What it demonstrates

- network-only extension permissions
- tool-driven API fetch flow
- custom `cardType` output routed into a host UI card
- a custom web component (`<weather-display-card>`) mounted by the host card wrapper
- API-free weather lookup using Open-Meteo geocoding + forecast endpoints

## Tool

### `get_weather`

Input:

```json
{
  "location": "San Francisco",
  "unit": "celsius"
}
```

Returns a JSON payload with:

- resolved location metadata
- current temperature, feels-like, humidity, wind, and conditions
- a 3-day forecast
- a short hourly outlook for the next few slots

The manifest sets `cardType: "weather-panel"`, so the chat UI renders the weather in a dedicated custom card instead of plain JSON.

## Permissions

```ts
permissions: {
  network: [
    "geocoding-api.open-meteo.com",
    "api.open-meteo.com"
  ]
}
```

No filesystem, shell, or secret env access is required.

## Install locally

```bash
ezcorp ext install ./docs/extensions/examples/weather
```

## Run tests

Extension runtime tests:

```bash
bun test ./docs/extensions/examples/weather/index.test.ts
```

Host card component tests:

```bash
cd web && bunx vitest run src/lib/components/tool-cards/WeatherCard.component.test.ts
```
