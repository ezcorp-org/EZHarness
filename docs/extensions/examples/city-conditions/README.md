# city-conditions

Ask about a city in chat and get its **current local time, weather, and
pollen** back as a `city-conditions` card. Mold is reported as explicitly
unavailable, with the reason — never as a number.

It also ships a **workflow**, `conditions`, that performs the same
aggregation as a declarative graph.

## Install

This extension is **not bundled** — it does not arrive pre-installed, and
nothing happens until you install it yourself. That is deliberate: it
calls third-party APIs, and an extension that reaches off-box should be
opt-in for a self-hosted deployment rather than auto-enabled everywhere.
The `weather` example is unbundled for the same reason.

```bash
ezcorp ext install ./docs/extensions/examples/city-conditions
```

Then **activate** it and grant the permissions it asks for — a fresh
install is disabled with nothing granted. Do that from the extension's
page in the UI, or:

```bash
curl -X POST https://your-host/api/extensions/<id>/activate
```

The permission prompt asks for network access to the three Open-Meteo
hosts listed below, and for the right to trigger its own `conditions`
workflow. There is no credential to supply.

Once it is installed, the shipped workflow registers as
`city-conditions:conditions` and appears on `/workflows` — extension
workflows are discovered from *installed* extensions, so being unbundled
costs the capability nothing.

## The tools

| Tool | Used by | Returns |
| --- | --- | --- |
| `city_conditions({ city, unit? })` | chat (renders the card) | the full envelope |
| `geocode({ city })` | workflow step `locate` | `{ v, ok, place }` |
| `current_weather({ latitude, longitude })` | workflow step `weather` | `{ v, ok, observedAt, localTime, weather }` |
| `air_quality({ latitude, longitude })` | workflow step `air` | `{ v, ok, pollen, mold }` |

All four go through the same two modules — `lib/open-meteo.ts` (every
upstream call) and `lib/pollen-bands.ts` (the banding). The chat tool does
not re-implement any of it; it composes the same helpers, fetching weather
and air quality concurrently with `Promise.all`.

## The result envelope

```jsonc
{
  "v": 1,
  "ok": true,
  "place": { "name": "Austin", "admin1": "Texas", "country": "United States",
             "latitude": 30.267, "longitude": -97.743, "timezone": "America/Chicago" },
  "unit": "celsius",                          // requested DISPLAY unit
  "observedAt": "2026-07-28T15:04:00-05:00",  // ISO, in the place's zone
  "localTime": "3:04 PM",                     // preformatted, place-local
  "weather": { "tempC": 34.2, "feelsLikeC": 38.1, "humidityPct": 55,
               "windKph": 12.4, "code": 2, "label": "Partly cloudy", "isDay": true },
  "pollen": {
    "grains": { "alder": null, "birch": 0.2, "grass": 8.1,
                "mugwort": null, "olive": null, "ragweed": 1.4 },
    "totalIndex": 9.7,      // sum of non-null grains, 1dp; null if ALL null
    "band": "moderate"      // none | low | moderate | high | very-high
  },
  "mold": { "available": false, "count": null, "band": null,
            "reason": "No keyless provider. Open-Meteo does not publish mold spore counts." }
}
```

`weather.tempC` / `feelsLikeC` are **always celsius**. `unit` carries the
display unit the caller asked for; converting is the card's job, so the
same envelope can be re-rendered either way without another upstream call.

Failure:

```jsonc
{ "v": 1, "ok": false, "code": "CITY_NOT_FOUND", "error": "No place matched \"Atlantis\"." }
```

`code` is one of `CITY_NOT_FOUND`, `UPSTREAM_UNAVAILABLE`, `BAD_INPUT`.

### Failures are shaped for their audience

`city_conditions` **never** returns `isError`. A failure arrives as the
`ok: false` envelope above with `isError: false`, because the card is what
has to render it — an error result would strand the reason in a generic
row, and a card showing nothing is a failure pretending to be a success.

The three granular tools **do** return `isError` on failure. Their caller
is a workflow step, and the executor turns an `isError` result into a
thrown, named step failure carrying the full message — more useful than a
downstream gate reporting only that a field is missing.

## Mold

Open-Meteo publishes no mold spore data. Every source that does (NAB,
Ambee, BreezoMeter, Tomorrow.io) requires a credential, and the
env-key-leak install gate refuses any `permissions.env` name ending in
`_API_KEY` / `TOKEN` / `SECRET` — so a keyed provider would have to take
its credential as a per-call tool input, which is a different product than
this one.

So `mold` ships present, honest, and with its reason attached. Fabricating
a count and dropping the field are the same lie in different clothes: the
second one just renders as a blank where a health figure belongs.

## The `conditions` workflow

```
locate  →  located  →  weather ∥ air  →  report      →  complete  →  output
(tool)     (gate)      (tool)  (tool)    (transform)     (gate)       (transform)
```

`weather` and `air` both declare `dependsOn: [located]` and nothing else,
so the executor's topological batcher places them in a single batch and
runs them concurrently. Two independent upstreams, one round trip of
latency — that concurrency is what the workflow buys over a single tool.

The trailing `output` step exists because a run's `result` is the **last
step's** output and a gate's output is the fixed `{passed: true}` — a
persisted run row carries no per-step outputs. Ending on `complete` would
finish green with the report unreachable, which is the same "succeeded but
shows nothing" failure this extension refuses to produce anywhere else.
`output` projects the gated report onto the run result, and re-asserts it
on the way past (transform refs are strict, so a field that vanished fails
the run by name).

Once the extension is installed, run it from `/workflows` or
`POST /api/workflows/city-conditions:conditions/run`.

**The chat tool does not run the workflow.** `ezcorp/workflows` is
fire-and-forget (the host starts the run and returns with no run id) and
`workflow:*` events are not extension-subscribable, so a tool physically
cannot await a run and return its aggregate for rendering. The two paths
share helpers, not control flow.

## Permissions

`network`, allowlisted to exactly the three keyless Open-Meteo hosts:

- `geocoding-api.open-meteo.com`
- `api.open-meteo.com`
- `air-quality-api.open-meteo.com`

plus `workflows: { names: ["conditions"], maxRunsPerHour: 12 }`, which is
what makes the shipped workflow triggerable (shipping the YAML is only an
asset; firing it is the privileged act).

No shell, no filesystem, no env, no storage. The extension holds no
credential and keeps no state.

## Verifying

```bash
bun test docs/extensions/examples/city-conditions/index.test.ts
bun test docs/extensions/examples/city-conditions/boot.test.ts
bun test src/__tests__/city-conditions-extension.test.ts
```

The suite never touches the network — upstream calls go through an
injected `fetch`. The manifest's `smokeTest` is network-free for the same
reason: it round-trips the real subprocess over JSON-RPC and asserts that
a bad input comes back as a renderable failure envelope
(`isError: false`, `"code":"BAD_INPUT"`) rather than an error result.
