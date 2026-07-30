# city-conditions

Ask about a city in chat and get its **local time, current weather, pollen,
and available mold activity** in a `city-conditions` card. The extension also
ships a `conditions` workflow with the same data flow.

Version 0.2 fixes two important coverage problems:

- Open-Meteo pollen is documented as **Europe-only and seasonal**. A successful
  response containing all `null` values is now an explicit unavailable state,
  not a zero and not a generic failure.
- Atlanta-metro lookups use **Atlanta Allergy & Asthma's National Allergy
  Bureau-certified reporting station**, which publishes an observed daily
  pollen total/category report and a mold activity band.

No API key or user configuration is required. Existing installations do need a
one-time extension re-approval after upgrading because v0.2 adds the narrowly
scoped `www.atlantaallergy.com` network permission; the bundled update gate will
otherwise keep the extension disabled, as designed.

## Provider strategy

| Data | Source | Coverage / freshness | Credential | Notes |
| --- | --- | --- | --- | --- |
| Geocoding | Open-Meteo | Global | None | Resolves the requested city and timezone. |
| Weather | Open-Meteo | Global current model/observation blend | None | Temperatures remain Celsius in the envelope; the card handles display conversion. |
| Pollen, Atlanta metro | [Atlanta Allergy & Asthma](https://www.atlantaallergy.com/pollen_counts) | Reporting station within 80 km of central Atlanta; daily report representing the previous 24 hours | None | NAB-certified station; total is grains/m³, with tree/grass/weed bands and top contributors. |
| Mold, Atlanta metro | Atlanta Allergy & Asthma | Same daily station report | None | Publishes an **activity band**, not a numeric spore count. The card preserves that distinction. |
| Pollen, other locations | [Open-Meteo Air Quality API](https://open-meteo.com/en/docs/air-quality-api) | Europe only, in pollen season; modeled current/forecast data | None | Six grains: alder, birch, grass, mugwort, olive, ragweed. |
| Mold, other locations | None configured | — | — | Returns a precise unavailable reason; no count is fabricated. |

### Sources considered but not selected as the zero-setup default

- [Google Pollen API](https://developers.google.com/maps/documentation/pollen/overview)
  has broad country coverage and five-day forecasts, but every request requires
  billing plus an API key or OAuth token. It does not solve measured mold.
- [Ambee Pollen API](https://www.getambee.com/api/pollen) offers global,
  species-level pollen data but requires a key.
- Tomorrow.io exposes keyed pollen forecast fields, but its published pollen
  layer does not provide a measured mold-spore field.
- The [AAAAI National Allergy Bureau](https://pollen.aaaai.org/) provides the
  right station-quality observations, but not one normalized, keyless public
  API. The Atlanta station page is therefore integrated as a narrowly scoped
  local provider rather than scraped as if it were a global feed.

A future host-brokered secrets surface could add Google or Ambee as an optional
provider without putting credentials in tool inputs. This release deliberately
stays keyless.

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

## Result envelope (v2, Atlanta example)

```jsonc
{
  "v": 2,
  "ok": true,
  "place": {
    "name": "Atlanta",
    "admin1": "Georgia",
    "country": "United States",
    "latitude": 33.749,
    "longitude": -84.388,
    "timezone": "America/New_York"
  },
  "unit": "fahrenheit", // requested display unit
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
      { "key": "trees", "label": "Trees", "band": "low", "contributors": ["MULBERRY"] },
      { "key": "grass", "label": "Grass", "band": "low", "contributors": ["GRASS"] },
      { "key": "weeds", "label": "Weeds", "band": "low", "contributors": ["PIGWEED", "RAGWEED", "PLANTAIN"] }
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

`weather.tempC` and `weather.feelsLikeC` are always Celsius. The requested
`unit` controls card display only. Pollen concentrations are **grains/m³**;
the old card's `µg/m³` label was incorrect and has been removed. Mold counts,
if a future provider supplies them, use **spores/m³**.

The card remains backward-compatible with persisted v1 envelopes: it accepts
`pollen.totalIndex` as a legacy alias for v2's `pollen.total`.

## Availability and failure behavior

Weather/geocoding failures still produce a structured top-level failure:

```jsonc
{ "v": 2, "ok": false, "code": "CITY_NOT_FOUND", "error": "No place matched \"Atlantis\"." }
```

Allergen failures are now field-level. A slow or unavailable allergen provider
must not erase valid weather:

```jsonc
{
  "pollen": {
    "available": false,
    "total": null,
    "band": "none",
    "reason": "Pollen provider unavailable: air-quality returned HTTP 503"
  },
  "mold": {
    "available": false,
    "count": null,
    "band": null,
    "reason": "No reporting-station mold source is configured for this location..."
  }
}
```

For Atlanta, station transport or parse failure falls back to Open-Meteo
pollen. If both providers fail, both health fields remain present and carry the
combined reason. Missing values never become zero.

## Permissions

`network` is the only I/O permission, restricted to:

- `geocoding-api.open-meteo.com`
- `api.open-meteo.com`
- `air-quality-api.open-meteo.com`
- `www.atlantaallergy.com`

The extension also declares
`workflows: { names: ["conditions"], maxRunsPerHour: 12 }` so its shipped
workflow can run. It has no shell, filesystem, environment, or storage access.

## Verifying

```bash
bun test ./docs/extensions/examples/city-conditions/index.test.ts
bun test ./docs/extensions/examples/city-conditions/boot.test.ts
bun test ./src/__tests__/city-conditions-extension.test.ts
(cd web && bunx --bun vitest run \
  src/lib/components/tool-cards/city-conditions-card-logic.unit.test.ts)
(cd web && bunx playwright test e2e/city-conditions-card.spec.ts \
  --config playwright.config.ts)
```

Unit and host tests use injected fetch responses and never require internet.
The live parser was also checked against the Atlanta station page; that check
is intentionally not part of CI, so a third-party outage cannot make the test
suite flaky.
