# Mock SSR `/api/extensions` diagnostic

This is a scoped temporary diagnostic against source `d2222840cf3d2b4963075ffc0f5cf0bdec5ef621`.

The isolated diagnostic added only `method`, `path`, and `status` to `handleError`. It logged one observed request during a single chat-graph mock test:

```text
GET /api/extensions -> 500
```

That test passed (`1 passed`). The source excerpts show the relevant order: in `PI_SKIP_INIT=1` preview, the hook permits a DB-unavailable request without a user; `/api/extensions` then calls `requireAuth` before `listExtensions`; a thrown route-handler `Response` is surfaced as 500; the universal chat layout catches the failed fetch and returns its normal empty load result.

This proves one caught, DB-free mock-preview fallback. It does not attribute all 105 mock-full records or all 68 generic visual-mock records to this request.

The first run failed before testing because owned symlinked dependencies made Vite resolve a temporary config in another worktree. A frozen local install succeeded. The next run used an anchored grep that matched no full Playwright title. Neither failure is a product or test result. The corrected run is the only observed result.

No production source was committed. `receipts/restored.txt` records that the diagnostic worktree returned to the original source state.

## Sanitization

Copied text files were transformed only with these substitutions, in this order:

```text
/home/dev/work/EZCorp/extension-v4-mock500-diagnostic -> <diagnostic-worktree>
/home/dev/work/EZCorp/extension-v4-independent-audit -> <audit-worktree>
[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12} -> <uuid> (case-insensitive)
```

The whole-file copies (the successful log, diagnostic diff, and receipt files) have no removed lines. Files under `terminal/` are explicitly named selected terminal excerpts for the two setup failures and the observed result. No raw browser reports, traces, storage state, headers, bodies, tokens, or authentication data are included.
