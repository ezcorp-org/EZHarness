# price-chart

Bundled example extension that renders **interactive stock and crypto price charts inline in chat**. Demonstrates how to ship a custom tool card *without* an iframe — the chart is drawn as SVG directly in the chat bubble.

| Tool | Source | Returns |
|---|---|---|
| `get_stock_chart({ ticker })` | Yahoo Finance (`query1.finance.yahoo.com`) | 1 year of daily closes + last/prev/logo |
| `get_crypto_chart({ symbol })` | CoinGecko (`api.coingecko.com`) | 1 year of daily USD prices + last/prev/logo |

## Why this pattern, not an iframe?

A typical "custom UI" extension (`claude-design`, `ask-user`) writes HTML to disk and returns an `iframeSrc` that the host serves through `/api/extensions/<name>/data/<path>`. That requires:

- `filesystem: ["$CWD"]` permission — but `fs.write` is a [sensitive capability](../../security.md). The first call prompts the user to "Allow"; if they don't click within 90 s, the watchdog kills the run.
- A round-trip through the SDK's host-mediated fs RPC.
- An iframe whose CSP must permit any external resources you want (`img-src`, `script-src`, etc.).

When the UI is small enough to render in Svelte, **skip all of that**. The tool returns a JSON payload; the host's `PriceChartCard.svelte` reads it and renders an inline SVG. No filesystem grant, no iframe, no CSP juggling, no permission prompt. The chart is just part of the chat bubble.

Use this pattern when:

- The card's UI is bounded (a chart, a stat block, a status pill) — Svelte can render it.
- You don't need bidirectional events back into the subprocess after the initial render. Range tabs that filter a pre-fetched dataset are local UI state — they don't need a tool round-trip.

Use the [full canvas-card pattern](../../canvas-cards.md) when you need iframe sandboxing for arbitrary user-supplied HTML, or when knob interactions must invoke the subprocess for new state.

## File layout

```
price-chart/
├── ezcorp.config.ts         # manifest: 2 tools, network-only permissions
├── index.ts                 # tool handlers (fetch + return JSON)
├── index.test.ts            # unit tests (mocked fetchers)
└── lib/
    ├── types.ts             # ChartData, ChartPoint, AssetKind
    ├── tickers.ts           # ~45 stock→domain + ~30 crypto→coingecko-id maps
    └── fetchers.ts          # Yahoo Finance + CoinGecko fetchers
```

The host-side card lives at:
- `web/src/lib/components/tool-cards/PriceChartCard.svelte` — the SVG renderer
- `web/src/lib/components/tool-cards/price-chart-logic.ts` — pure helpers (parsing, slicing, scaling, formatting)
- `web/src/lib/components/tool-cards/price-chart-logic.test.ts` + `PriceChartCard.component.test.ts` — coverage

## Tool result shape

Both tools return a JSON-encoded string in the standard tool-result envelope:

```jsonc
{
  "_assistant_note": "Chart rendered inline. Respond briefly; do NOT call again.",
  "kind": "stock",                                  // or "crypto"
  "symbol": "AAPL",
  "name": "Apple Inc.",
  "logoUrl": "https://logo.clearbit.com/apple.com",
  "currency": "USD",
  "lastPrice": 290.50,
  "prevClose": 285.10,
  "points": [{ "t": 1735689600000, "v": 245.30 }, /* ~250 daily points */ ]
}
```

The `_assistant_note` field is a deliberate first-key signal to the LLM that the chart is already on screen and it should respond with a one-liner rather than loop on the tool.

## Permissions

```ts
permissions: {
  shell: false,
  eventSubscriptions: [],
  network: ["query1.finance.yahoo.com", "api.coingecko.com"],
}
```

**Note what's *not* there:** no `filesystem`, no `storage`. Logos load via `<img src>` in the browser, which is a browser-side fetch — the extension subprocess never touches Clearbit or CoinGecko's image CDNs, so they don't need to appear in the network allowlist.

## Wiring the card on the host side

Two host-side touch points are needed for any extension that uses a custom `cardType`:

1. **`getCardComponentName` in `web/src/lib/components/tool-cards/utils.ts`** — add `case 'price-chart': return 'PriceChartCard';`.
2. **`ToolCardRouter.svelte`** — import the component and add a `{:else if cardName === 'PriceChartCard'}` branch.

Both are unit-tested (`web/src/__tests__/tool-card-router.test.ts`).

## End-to-end coverage

| Test file | What it covers |
|---|---|
| `docs/extensions/examples/price-chart/index.test.ts` | Tool handler input validation, symbol resolution, mocked-fetch happy path, error wrapping (17 tests) |
| `web/src/lib/components/tool-cards/price-chart-logic.test.ts` | Payload parsing (string / MCP envelope / object), range slicing, SVG path generation, nearest-point hit testing, formatters, change derivation across range switches (24 tests) |
| `web/src/lib/components/tool-cards/PriceChartCard.component.test.ts` | DOM tests: header rendering, default range, range-tab clicks, accent-color sync across bar/line/gradient (regression pin for the "bar green / line red" bug), unique gradient ID per instance (regression pin for ID collision), hover tooltip, error fallback, logo placeholder + onerror (14 tests) |
| `web/src/__tests__/tool-card-router.test.ts` | `cardType: "price-chart"` → `PriceChartCard` (+ permissionPending gate respect) |
| `web/src/__tests__/price-chart-stream-bridge.test.ts` | Bus → SSE event → chat-store reducer. Five synthetic-event cases pin the `tool:start`/`tool:complete`/error reducer paths against the price-chart payload shape; a sixth gated on `EZCORP_E2E_NETWORK=1` runs the REAL `ToolExecutor.executeToolCall` with a real `EventBus`, captures the emitted bus events, feeds them through the replicated reducer, and asserts the resulting `streamingToolCalls` entry has the shape `PriceChartCard` can parse. Verifies the WHOLE chain executor → bus → store → card-side parser, end to end (6 tests). |
| `src/__tests__/price-chart.e2e.test.ts` | Real subprocess spawn under the sandbox-preload; `ToolExecutor.executeToolCall` with stub PDP; `extensionToAgentTool.execute` with real DB-backed PermissionEngine. Live-network paths gated on `EZCORP_E2E_NETWORK=1`; real-PDP gated on `EZCORP_E2E_REAL_PDP=1`. The real-PDP test asserts `elapsed < 10_000 ms` so a re-introduction of any sensitive-cap prompt fails loudly (6 tests + 1 network-gated). |

To run everything:

```sh
bun test ./docs/extensions/examples/price-chart/index.test.ts
bun test ./web/src/lib/components/tool-cards/price-chart-logic.test.ts
bun test ./web/src/__tests__/tool-card-router.test.ts
bun test ./web/src/__tests__/price-chart-stream-bridge.test.ts                    # offline
EZCORP_E2E_NETWORK=1 bun test ./web/src/__tests__/price-chart-stream-bridge.test.ts # + live executor
cd web && bunx vitest run src/lib/components/tool-cards/PriceChartCard.component.test.ts
EZCORP_E2E_NETWORK=1 bun test ./src/__tests__/price-chart.e2e.test.ts
# Inside a running container with DB:
EZCORP_E2E_NETWORK=1 EZCORP_E2E_REAL_PDP=1 bun test ./src/__tests__/price-chart.e2e.test.ts
```

## Range switching contract (subtle)

The headline `+X.XX (+Y.YY%)` row is anchored to the **first and last points of the visible slice**, not to the `prevClose` field carried in the payload. Switching the 1W / 1M / 3M / 1Y tabs re-derives the change:

- `change = computeChange(slice.at(-1).v, slice.at(0).v)` — see `PriceChartCard.svelte`.

The displayed `lastPrice` (top-right of the card) stays as the latest data point regardless of range — that's the "current price". The `prevClose` field is preserved in the payload (it's the asset's official 24h-ago close, which the LLM can quote in prose) but isn't used by the card itself.

## Limitations / non-goals

- Daily resolution only. Intraday would require canvas events + a second tool call per range switch — out of scope for the v1 demo.
- No multi-symbol overlays.
- No persistent watchlists.
- No real-time updates.

These are all reasonable extensions of the pattern but each is a separate phase.
