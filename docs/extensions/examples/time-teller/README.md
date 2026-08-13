# time-teller

A pure-compute EZCorp extension that gets the current time and renders a live wall clock inline in chat. The analog hour, minute, and second hands update every second in the browser, alongside a localized digital time, date, timezone, locale, and ISO timestamp.

## Tool

### `tell-time`

All inputs are optional:

```json
{
  "timezone": "Asia/Tokyo",
  "locale": "ja-JP",
  "hour12": false
}
```

- `timezone`: IANA timezone. Defaults to `UTC`.
- `locale`: BCP 47 locale. Defaults to `en-US`.
- `hour12`: optional 12/24-hour display preference.

The manifest declares `cardType: "time-clock"`, so the host routes the JSON payload to `TimeClockCard.svelte`. The result contains an initial timestamp, while the card advances from the browser's current time after rendering.

## Permissions

None. Reading the system clock and formatting it with `Intl.DateTimeFormat` requires no network, filesystem, shell, storage, or environment access.

## Install locally

```bash
bun src/cli.ts ext install ./docs/extensions/examples/time-teller
```

## Test and verify

```bash
bun test ./docs/extensions/examples/time-teller/index.test.ts
bun src/cli.ts ext verify ./docs/extensions/examples/time-teller
```
