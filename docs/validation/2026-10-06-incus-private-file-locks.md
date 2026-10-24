# Incus private file locks — 6 October 2026

Status: source fix and replacement image verified. The updated provider and a new EZHarness-native workflow are still required.

## Observed failure

The isolated EZHarness app at `e02641500` created and started a guest through the project UI. Native file reads and edits worked. Three application tests, the pinned Compose fixture and a Git commit succeeded. The final clean-tree check failed because the helper left two `.ezh-lock-*` files beside the edited files.

Filtering these files from directory listings did not hide them from Git. Removing a lock after each call would also be unsafe: an existing waiter can hold the old inode while another writer opens a new one.

The failed guest's files and history were preserved, including a verified Git bundle with SHA-256 `f7d7a5a8e803de3a0cd67e7d98c7aed97c07376b61b22ae05402129b9f557f0b`. Ordinary stop and deletion completed. Independent inventory and accounting checks confirmed no remaining guests or reservations. This cleanup does not turn the failed workflow into a pass.

## Fix

Commit `bf80a50e3` moves stable path locks to `mutations/file-locks` under the private helper state directory. Lock identity includes the sandbox, opened parent directory identity and filename. The implementation preserves descriptor containment, stable inodes, file locking, revision checks and mutation journals. It rejects unsafe directory and lock-file metadata.

Helper protocol version remains `0.1.0`. The new helper SHA-256 is `caa4fd5ce201ada90d89477f2f5dab47af7f78bb6cba805433b668e53fbb47bd`. Existing guest images still contain the old helper; changing source alone does not update a guest.

## Verification

All 15 helper tests passed in the source worker, independent review and root worktree. The tests include real helper writes and removals followed by a real Git commit and clean status, concurrent revision checks, lock aliases, stable inodes, unsafe symlinks and hardlinks, and existing process controls.

The root regression also passed with deliberately invalid inherited `GIT_DIR` and `GIT_INDEX_FILE` values. Git fixture subprocesses remove inherited `GIT_*` variables. This prevents a commit hook's repository environment from redirecting fixture commits into the source repository. The normal commit hook passed, and an independent review confirmed that the integrated commit contains only the three reviewed helper files.

## Remaining gate

The existing builder produced image `f0b8298a2e61667625f28824fd85b1b06b469c731b31a625fff6972b71460545`, alias `ezharness-guest-0-1-4`. A separate bounded guest from that exact image ran the pinned helper as UID/GID 1000. Actual hello, revision-checked write and removal succeeded, and both Git commits left a clean checkout. Independent review verified the build result, image retention, helper result and cleanup. Both temporary instances and their volumes were absent afterward.

The build started despite a failed local control-plane memory guard because the launch used a separate tool call. Initial measurements were not saved, so the original guard cannot be called a pass. Fresh measurements showed ample sandbox-server headroom and no memory pressure; the original bounded build continued once. The later canary saved its measurements and used a single sequential caller that refused admission on a failed guard. This execution error remains part of the evidence.

Publish the reviewed provider revision through v4, verify its connection and repeat the EZHarness-native workflow. The direct image canary does not replace that workflow. Final repository gates and ten lifecycle tests remain open.
