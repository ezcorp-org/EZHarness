# Graded Card Scanner

Scan graded-card slabs with your phone, build a saved list, and see
**price + population by grade** for every card — inside EZCorp. Attach a
slab photo in chat and it is identified **automatically** (any grader:
PSA / CGC / BGS / SGC) with a per-company grade-price chart.

## What ships

| Piece | Where |
|---|---|
| Scanner web app (camera + upload + manual entry, saved list, detail view with grade table + chart) | `app/`, deployed by postinstall and served session-authed at `/api/extensions/graded-card-scanner/data/app/index.html` |
| `lookup_card(cert, fresh?)` tool | `index.ts` — called by the app via `POST /api/tool-invoke`, and callable by the LLM in chat |
| `identify_slab(attachment, filename?, mimeType?)` tool + **deterministic preprocessor** | `index.ts` + `ezcorp.config.ts` `preprocessors` — the host runs it automatically on PNG/JPEG attachments (see [Slab photos in chat](#slab-photos-in-chat-deterministic-preprocess)) |
| `set_psa_token(token)` tool | `index.ts` — saves your free PSA API token (encrypted, never echoed) |
| Live lookup pipeline (PSA API + PriceCharting, per-host politeness, per-cert cache) | `lib/` — `pipeline.ts`, `sources/psa-api.ts`, `sources/pricecharting.ts`, `politeness.ts`, `token.ts` |
| Multi-grader identify pipeline (host-side barcode decode, grader classify, CGC cert page, per-company prices, adjacent-grade deltas) | `lib/` — `identify.ts`, `decode.ts`, `classify.ts`, `sources/cgc.ts`, `deltas.ts` |
| "Card Scanner" Hub dashboard (recent lookups, stats, scanner link) | `lib/page.ts` — tab at `/hub/ext:graded-card-scanner:dashboard` |
| Shared pure logic (cert parsing, dedupe gate, table math, chart SVG, decode ladder geometry) | `app/lib/*.js` — one source for both the browser and the subprocess |
| Live sanity check (verify PSA/PriceCharting field-name assumptions) | `scripts/sanity-check.ts` |

## Slab photos in chat (deterministic preprocess)

Wire the extension to a conversation (mention `![ext:graded-card-scanner]`
or use it once) and attach a slab photo (PNG/JPEG): the host runs
`identify_slab` on it **deterministically — no LLM tool-call needed —
before the reply streams** (see
[docs/features/extensions/deterministic-preprocess.md](../../../features/extensions/deterministic-preprocess.md)).
The transcript shows a **grade-delta chart card** (grader badge, cert,
identity, per-company adjacent-grade % price steps, price table) and the
model's reply is grounded in the same JSON.

What `identify_slab` does, per grader:

- **Decode** happens host-side with the same proven ladder geometry the
  phone app uses (`app/lib/decode-plan.js`): whole frame, upscaled bands,
  then a quiet-zone tile grid. Formats: ITF, QR, Code 128.
- **PSA** — `psacard.com/cert` QR or the bare ITF front label → identity
  + population from the official API (token optional → honest nulls).
- **CGC** — `cgccards.com`/`cgccomics.com` cert QR → identity scraped
  from the **public cert page** (robots-gated, per-host queue). The
  lookup always fetches `www.cgccards.com`, whichever host the QR
  encodes — it is the only CGC host in the network grant.
- **BGS / SGC** — v1 is **decode-only**: cert + grader with identity
  nulls, stamped `decode-only`. (OCR identity is documented out of scope.)
- **Prices** — the PriceCharting product page's **full price guide**
  supplies per-company graded columns (PSA/BGS/CGC/SGC × grades); the
  card charts the % step between each adjacent priced grade pair per
  company. Missing values are always null/N/A, never a guess.

## Run it

```bash
# from the repo root
bun src/cli.ts ext install docs/extensions/examples/graded-card-scanner
# postinstall deploys app/ into .ezcorp/extension-data/graded-card-scanner/app/
```

Open `/api/extensions/graded-card-scanner/data/app/index.html` in a
browser logged in to your EZCorp instance. On a phone, use your
deployment's HTTPS address.

**No API keys are needed to try it.** With no backend data source
configured the app runs in **mock mode**: the full scan → list →
detail → chart flow works with zero network using a built-in sample
card (1999 Base Set Charizard #4). The "Simulate scan" button and
manual cert entry exercise everything without a camera.

## Camera notes

- Live continuous scanning needs a **secure context** (HTTPS or
  localhost) *and* the platform's camera header opt-in. Without them,
  the **Photo** button still works — it opens the native camera app via
  `<input capture>` and decodes the still — as do manual entry and
  simulate.
- **What's on a slab:** the PSA **front label** carries an **ITF**
  (Interleaved 2 of 5) linear barcode; modern slabs *also* print a **QR**
  on the back that encodes a `psacard.com/cert` URL. Very old slabs have
  **neither** — type the cert in manually. The reader tries ITF, Code 128
  and QR.
- A thin ITF label doesn't decode from a raw full-resolution photo, so a
  still upload is walked through a **bounded ladder** and stops at the
  first hit — see `app/lib/decode-plan.js`: the whole frame, then upscaled
  horizontal bands, then a fine **quiet-zone tile grid** (each tile is
  isolated and framed in white) for a small barcode buried in label text
  that no wide band can present cleanly. Manual entry is always the
  reliable fallback.

## PSA API token setup

Identity + population come from PSA's **official public API**, which needs
a free developer token (get one at `api.psacard.com`). The token is
**never** written to code, logs, or a tool result:

- **In chat:** paste the token and the model calls `set_psa_token`. It is
  stored **encrypted** in per-user extension Storage and used for every
  subsequent lookup. This is the supported way to supply the token.

> Local dev only: the `scripts/sanity-check.ts` CLI reads a `PSA_API_TOKEN`
> environment variable if one is already set in the process (see
> [Verifying live data](#verifying-live-data-sanity-check)). This is a
> convenience for a local sanity check — it is **not** an install or
> runtime credential path (the manifest declares no `env` grant, so the
> host never passes it through to the running extension).

No token → identity and population come back **null** and the record is
stamped `psa-api:no-token` (the UI shows N/A). Prices still work — they
need no token.

## Data sources & honest caveats

- **PSA API only for identity/population.** PSA's website blocks keyless
  scraping (Cloudflare interactive challenge, verified 2026-07-06); per
  this project's politeness rules we do **not** fight it.
- **Population is only the scanned grade's count.** The official API's
  per-cert response exposes `TotalPopulation` (this grade) and
  `PopulationHigher` — *not* the full grade-by-grade population report.
  A complete pop-by-grade table has no politely-reachable source, so the
  record carries population on the **scanned grade row only**; every
  other grade's population is honestly `null`. (The full pop report is a
  documented out-of-scope limitation, not a bug.)
- **Prices come from PriceCharting** product pages — keyless, fetched
  politely: a per-host ≥1.1s gap, robots.txt respected, a real browser
  user agent, no CAPTCHA/proxy evasion. A specific-enough search
  redirects straight to the product page, so that lookup is parsed in
  place with no second request. An unconfident product match attaches
  **no** prices rather than the wrong card's.
- **Low grades are often blank.** PSA 1–6 have no PriceCharting column at
  all (→ `null`), and even mapped grades can be blank when a card rarely
  sells. A missing value is always **N/A, never $0**.
- Every value shows its source + fetch time. "Fetch fresh" re-pulls and
  is briefly disabled after use.

### PriceCharting grade → column mapping (locked)

PriceCharting publishes one price column per tier. The grades map as:

| Grade | PriceCharting column |
|---|---|
| Ungraded | `used_price` |
| PSA 7 | `complete_price` |
| PSA 8 | `new_price` |
| PSA 9 | `graded_price` |
| PSA 10 | `manual_only_price` |

`box_only_price` (grade 9.5) is intentionally unused, and PSA 1–6 have
no column → those grades are always `null`.

## Verifying live data (sanity check)

Because the parsers degrade to `null` on shape drift (never crash), a
silent PSA/PriceCharting field rename would slip past the offline unit
tests. The sanity script is the deliberate **live** check:

```bash
# live — local dev only: this CLI reads PSA_API_TOKEN from the environment.
# (The installed extension gets its token from set_psa_token, not this var.)
PSA_API_TOKEN=… bun docs/extensions/examples/graded-card-scanner/scripts/sanity-check.ts 49392223 [more certs…]

# offline — runs the same checks against the bundled fixtures
bun docs/extensions/examples/graded-card-scanner/scripts/sanity-check.ts 49392223 --fixtures
```

For each cert it asserts identity fields are present, every population is
an integer-or-null, every price is money-or-null, and a second lookup is
served from cache. Any failure exits non-zero.

## Storage

- Your scanned list lives **on the device** (IndexedDB) and survives
  reloads; already-scanned certs are never looked up twice.
- Lookup results are also cached server-side per cert (extension
  Storage), so re-scans and other devices reuse them; `fresh=true`
  bypasses the cache.
