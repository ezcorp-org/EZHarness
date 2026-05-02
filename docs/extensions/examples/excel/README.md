# excel

Read Excel (`.xlsx`) workbooks attached to chat. Drop a workbook into the
composer, and the assistant can ask the `read-spreadsheet` tool for sheet
manifests, full sheets as markdown tables, or A1-notation ranges.

## How it works

1. Wire the extension into the conversation with `!ext:excel`.
2. The composer's accept list now includes the xlsx MIME type
   (`application/vnd.openxmlformats-officedocument.spreadsheetml.sheet`).
3. Drag-drop a `.xlsx`. The host emits a small `<file>` block in the user
   message containing only the attachment handle (`ez-attachment://<id>`)
   — the bytes do **not** land in the prompt. This keeps context tiny no
   matter how big the workbook is.
4. The LLM calls `excel.read-spreadsheet` with `source: "ez-attachment://…"`.
   The host substitutes the handle to a `data:` URI before the tool sees
   it; the tool decodes, parses with ExcelJS, and returns markdown.

## Tool: `read-spreadsheet`

| Mode | Required args | Returns |
|------|---------------|---------|
| `manifest` | `source` | All visible sheet names + dimensions + first 5 sample rows. Call this first. |
| `sheet` | `source`, `sheet` | The named sheet rendered as a markdown table (capped at 1000 rows by default). |
| `range` | `source`, `sheet`, `range` (A1) | Just the cells inside the range. |

Optional: `maxRows` (1–5000, default 1000).

## Defensive defaults

- **Hidden sheets are skipped** — no leaks from intentionally-hidden tabs.
- **External references are rejected at load** — workbooks that link to
  other files refuse to open (data exfiltration vector).
- **Cached formula results, not formula text** — `=SUM(A1:A10)` shows as
  `55`, not the formula.
- **Dates emit as ISO 8601** — never raw Excel serials.
- **Merged cells forward-fill** — child cells inherit the master value
  rather than appearing blank.
- **256 KB output cap per call** — protects context budgets even when
  the row cap is high.
- **>50 columns falls back to fenced CSV** — markdown tables become
  unreadable past that width.

## Format support

Only `.xlsx` (Office Open XML). `.xlsm` (macros) and `.xls` (legacy BIFF)
are deliberately not in the accept list — the parser surface is dirtier
and `.xlsm` carries macro payloads we don't want to encourage uploading.
