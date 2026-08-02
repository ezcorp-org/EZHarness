# city-conditions

Ask about a city in chat and get its **local time, current weather, pollen,
and available mold activity** in a `city-conditions` card. The extension also
ships a `conditions` workflow with the same data flow.

Version 0.3 adds broad modeled pollen coverage without weakening the existing
observed-data path:

- A configured **Google Pollen API** key supplies daily 0–5 Universal Pollen
  Index (UPI) values for trees, grass, and weeds, including broad U.S. coverage.
  UPI remains labeled as an index; it is never presented as grains/m³.
- Atlanta-metro lookups still prefer **Atlanta Allergy & Asthma's National
  Allergy Bureau-certified reporting station**, which publishes an observed
  daily pollen total/category report and a mold activity band.
- Open-Meteo remains the keyless, Europe-only seasonal pollen fallback. Missing
  data stays unavailable rather than becoming zero.

## Google Pollen setup

The Google key is optional and bring-your-own-key:

1. Enable the Pollen API and billing in Google Cloud.
2. Create an API key and restrict it to the Pollen API where possible.
3. Open the `city-conditions` extension detail page and save the key under
   **Settings → Google Pollen API key**.

The host stores the value encrypted in per-user extension Storage. It never
enters settings JSON, tool inputs, logs, or a credential-shaped environment
grant. Without a key, the Atlanta station and Open-Meteo fallback still work.

Existing installs require re-approval because v0.3 adds
`pollen.googleapis.com` and Storage. Fresh installs receive the clamped grant
automatically.

## Provider strategy

Providers are selected in this order:

1. Within 80 km of central Atlanta, use the local NAB-certified observed
   station for pollen and mold activity.
2. If a Google key is configured, use Google Pollen's modeled UPI.
3. Fall back to Open-Meteo's keyless Europe-only pollen model.

| Data | Source | Coverage / freshness | Credential | Notes |
| --- | --- | --- | --- | --- |
| Geocoding | Open-Meteo | Global | None | Resolves the requested city and timezone. |
| Weather | Open-Meteo | Global current model/observation blend | None | Temperatures remain Celsius in the envelope; the card handles display conversion. |
| Pollen, Atlanta metro | [Atlanta Allergy & Asthma](https://www.atlantaallergy.com/pollen_counts) | Local daily report representing the previous 24 hours | None | Preferred observed source. Total is grains/m³, with tree/grass/weed bands and contributors. |
| Mold, Atlanta metro | Atlanta Allergy & Asthma | Same daily station report | None | Publishes an **activity band**, not a numeric spore count. |
| Pollen, configured coverage | [Google Pollen API](https://developers.google.com/maps/documentation/pollen/overview) | Broad country coverage, including the U.S.; modeled daily forecast | Per-user Google API key | Tree/grass/weed 0–5 UPI. Billing and API enablement are required. |
| Pollen fallback | [Open-Meteo Air Quality API](https://open-meteo.com/en/docs/air-quality-api) | Europe only, in pollen season | None | Six grain concentrations: alder, birch, grass, mugwort, olive, ragweed. |
| Mold, other locations | No configured NAB station | — | — | Google Pollen and Open-Meteo do not provide mold-spore data. No count is fabricated. |

### Mold coverage limitation

The [AAAAI National Allergy Bureau](https://pollen.aaaai.org/) provides the
right station-quality observations, but not one normalized nationwide public
API. This extension integrates the Atlanta station only within its stated
local scope rather than pretending one station represents the country. Google
solves broad modeled **pollen** coverage; it does not provide mold. A future
commercial mold integration should be added only after its location coverage,
units, licensing, timestamps, and credential handling are verified.

## Tools

| Tool | Used by | Returns |
| --- | --- | --- |
| `city_conditions({ city, unit? })` | Chat; renders the card | Full envelope |
| `geocode({ city })` | Workflow `locate` step | `{ v, ok, place }` |
| `current_weather({ latitude, longitude })` | Workflow `weather` step | Weather observation |
| `air_quality({ latitude, longitude })` | Workflow `air` step | Best pollen/mold result with provenance |

The chat tool geocodes first, then requests weather and allergen data in
parallel. The workflow expresses the same shape declaratively. Both paths use
the same provider functions.

## Result envelope v3

An Atlanta station result keeps observed concentration and band-only mold data:

```jsonc
{
  "v": 3,
  "ok": true,
  "place": {
    "name": "Atlanta",
    "admin1": "Georgia",
    "country": "United States",
    "latitude": 33.749,
    "longitude": -84.388,
    "timezone": "America/New_York"
  },
  "unit": "fahrenheit",
  "observedAt": "2026-07-29T15:04:00-04:00",
  "localTime": "3:04 PM",
  "weather": {
    "tempC": 30.6,
    "feelsLikeC": 35.6,
    "humidityPct": 61,
    "windKph": 9.2,
    "code": 1,
    "label": "Mainly clear",
    "isDay": true
  },
  "pollen": {
    "available": true,
    "grains": null,
    "total": 4,
    "unit": "grains/m³",
    "band": "low",
    "categories": [
      { "key": "trees", "label": "Trees", "band": "low", "contributors": ["MULBERRY"] }
    ],
    "observedAt": "2026-07-29",
    "source": {
      "id": "atlanta-allergy",
      "name": "Atlanta Allergy & Asthma",
      "url": "https://www.atlantaallergy.com/pollen_counts",
      "kind": "observed",
      "certification": "National Allergy Bureau-certified station"
    },
    "reason": null
  },
  "mold": {
    "available": true,
    "count": null,
    "unit": null,
    "band": "very-high",
    "observedAt": "2026-07-29",
    "source": {
      "id": "atlanta-allergy",
      "name": "Atlanta Allergy & Asthma",
      "url": "https://www.atlantaallergy.com/pollen_counts",
      "kind": "observed",
      "certification": "National Allergy Bureau-certified station"
    },
    "reason": "The station publishes a mold activity band, not a numeric spore count."
  }
}
```

A Google pollen block instead carries provider-native UPI values:

```jsonc
{
  "available": true,
  "grains": null,
  "total": 4,
  "unit": "UPI",
  "band": "high",
  "categories": [
    { "key": "trees", "label": "Tree", "value": 4, "band": "high", "contributors": [] },
    { "key": "grass", "label": "Grass", "value": 2, "band": "low", "contributors": [] },
    { "key": "weeds", "label": "Weed", "value": 3, "band": "moderate", "contributors": [] }
  ],
  "observedAt": "2026-07-28",
  "source": {
    "id": "google-pollen",
    "name": "Google Pollen API",
    "kind": "modeled"
  },
  "reason": null
}
```

`weather.tempC` and `weather.feelsLikeC` are always Celsius. The requested
`unit` controls card display only. Station/Open-Meteo pollen values are
**grains/m³**; Google values are **UPI**, not concentrations. Mold counts, if a
future provider supplies them, use **spores/m³**.

The card remains backward-compatible with persisted v1/v2 envelopes: it accepts
`pollen.totalIndex` as a legacy alias for `pollen.total`, and category `value`
is optional.

## Availability and failure behavior

Weather/geocoding failures produce a structured top-level failure:

```jsonc
{ "v": 3, "ok": false, "code": "CITY_NOT_FOUND", "error": "No place matched \"Atlantis\"." }
```

Allergen failures are field-level, so they do not erase valid weather. If every
applicable pollen provider fails or has no value, the field carries the
combined provider reasons. Mold availability remains independent. Missing
values never become zero.

## Permissions

Runtime I/O is restricted to:

- Network: `geocoding-api.open-meteo.com`, `api.open-meteo.com`,
  `air-quality-api.open-meteo.com`, `pollen.googleapis.com`, and
  `www.atlantaallergy.com`.
- Storage: per-user encrypted Google Pollen key at `google-pollen-api-key`.

The extension also declares
`workflows: { names: ["conditions"], maxRunsPerHour: 12 }` so its workflow can
run. It has no shell, filesystem, or environment access.

## Verifying

```bash
bun test ./docs/extensions/examples/city-conditions/index.test.ts
bun test ./docs/extensions/examples/city-conditions/boot.test.ts
bun test ./src/__tests__/city-conditions-extension.test.ts
(cd web && bunx --bun vitest run \
  src/lib/components/tool-cards/city-conditions-card-logic.unit.test.ts)
bun run scripts/regenerate-manifest-lock.ts --check
```

Unit and host tests use injected fetch responses and never require internet.
