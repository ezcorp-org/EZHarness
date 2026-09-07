# Request body formats — d4ffe706

The parent independently passes all 13 payload cases with 27 assertions. The actual Bun HTTP path preserves a multipart boundary, Unicode text and filename, exact binary file bytes and media type, a custom header, and async event identity. Direct non-null empty streams and zero-byte HTTP POSTs retain their expected body state. The unchanged two-batch retention regression also passes.

Terra passes the same 13 Bun cases and three existing bounded-JSON Vitest cases. Its original `web-typecheck` label refers to SvelteKit sync and Svelte check (zero errors, 13 warnings), not canonical root typechecking. The preserved original results file is not relabeled as a root-type pass.

The first parent canonical root typecheck exits 1 because copied R4 evidence used executable `.ts` suffixes. Exact bytes were retained under `.ts.txt`; the separate full follow-up passes all four sections. The first failure remains here. No product code changed for that correction.

Checks ran against image-source checkout `9ca27583` plus the exact test patch recorded here. The test bytes match subsequent commit `d4ffe706c86049ee15515c79377234765ee86208`, which changes only this file and passes normal commit hooks. Production source and image remain `9ca27583`; this test-only commit does not invalidate that image's resource result. The server harness shares the actual adapter clone, async context, and admission function; it does not import the whole application hook.
