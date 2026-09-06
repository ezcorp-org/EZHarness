# Imported Storage Candidate Diagnosis

This record diagnoses the failed marketplace candidate at source commit
`2af9cb4fe625cef1de19b59139e38d8976d8acc6`. No production source was changed
in this worktree.

The saved browser receipt reports a candidate build failure at
`extension-source-import.spec.ts:125` with the generic lifecycle diagnostic
`operation_failed`. See the import worktree receipt:

`/home/dev/work/EZCorp/extension-v4-flow-import/docs/validation/extension-v4-flows/import/raw/source-import-full-2af9cb4f.log`.

At that commit, the generated `echo` handler returned both `text` and
`sentinel`, but its manifest still declared an output object that required
only `text` and denied extra properties. The candidate verifier invokes the
declared smoke tool and validates the result against `tool.outputSchema` in
`src/extensions/extension-lifecycle-service.ts`. The raw validator receipt
shows that the old schema rejects the real result and the corrected schema
accepts it: [contract receipt](artifacts/import-storage-output-schema-contract-20260906.log).

The runner build itself performs typecheck, compile, feature tests, and
metadata discovery. It does not invoke the smoke tool. The SDK session turns
a handler `ContractError` into the generic RPC message `Extension handler
failed`; lifecycle therefore recorded the saved generic failure instead of a
schema-specific message.

The import worktree commit `21eef8656f6cbd8b9a9a3b8f8fc76132b16988d6` changes
the output schema to require `text` and nullable `sentinel`. It should be
validated by the corrected marketplace browser flow, not by another queued
old-source build.
