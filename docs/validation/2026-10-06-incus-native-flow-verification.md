# Incus qualification passed; full native workflow still pending

The isolated EZHarness app at source `178525ad3` passed real qualification on
the selected Incus host, image and Compose profile. This does not establish
completion of the full infrastructure PRD.

## Actual live results

- Qualification completed through the normal app, including automatic engine
  restart and lost-delete-response recovery. Its terminal receipt is
  `315af611b951667dd0701e43cac8e515d4e39d9f5e846bbe02e1ac3d39080ee9`.
- All three qualification fixtures were removed. Independent detached-copy
  accounting found zero charges, no actionable operations and no provider
  drain. Completion receipt:
  `150c7dc66ecfaa2ac3992527ee0739797433345eb47368b1af8a2579df4c4fdc`.
  Historical UNKNOWN operations remain preserved and compensated.
- The browser created and started a sandbox, opened its conversation, and
  retained the same project and conversation after reload. Browser result:
  `f882ba372ef300e8d867bc049aa271e9e95a27572a6ddd4ff4878daf44472ce3`.
- A real model-invoked `shell` call on that project ran `pwd` and returned
  `/workspace`. Saved-message receipt:
  `bb7465a7cea6d296925ac5f3cafe7492e3f32044a7dba90424fbfb87e442aaa4`.
  This is shell evidence, not full file, Git or Compose evidence.

The qualification expires at `2026-10-06T11:09:41.416Z`. Restart does not renew
it; new admissions must pass the current qualification checks.

## Defect found by the real agent test

The first full native turn called `task_plan`, which was unavailable, then
stopped without workspace actions. Its saved messages are
`3c6f757131be4cb601c11353271d7a35cd8a86b62f67ae7d45324278217e952b`.
The request was not replayed. The scoped tools API is not the full native model
catalog, so its omission of shell tools was not evidence that shell was absent.

The actual executor request fixture reproduced the defect: its system prompt
required `task_plan` even when the final tools did not contain it. The repair
adds normal-run planning instructions after the final tool filters and only
when all referenced tools are present. It uses their exact exposed names,
including extension prefixes. Existing orchestrator behavior is unchanged.
Independent review and 29 focused tests passed; integrated checks and a live
full-workflow rerun remain required.

## Repository checks and remaining work

On `178525ad3`, backend tests passed 27,615 cases across 1,785 files. All five
browser lanes passed: mock gate 283, mock full 1,441, visual evidence 396, fresh
setup seven, and real-auth 138. Merged coverage and later coverage gates were
still running when this record was written. These results cannot be presented
as checks of a later source revision.

Remaining: install the corrected runtime; finish browser lifecycle controls;
prove full native file/Git/Compose behavior, process control, retention,
restart, denied access and ten complete lifecycles; verify final cleanup and
accounting; complete final-source local and hosted checks and PR review.

New projects have empty workspaces. Automatic repository bootstrap,
authenticated preview UI, process-log browser, project-bound MCP execution,
guest secret delivery, independent-provider portability and stock Claude/Codex
workers remain deferred. Earlier memory-pressure failures are retained in
[the diagnostic record](2026-10-06-incus-memory-diagnostic-result.md); later
passes do not establish their cause.
