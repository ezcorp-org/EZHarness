# Isolated Incus provider 0.1.3 release review

Status: verified candidate; human approval and activation pending.

This request covers approval of this exact extension release and its activation
in the isolated EZHarness app after the old provider resources drain. It does
not apply a server setup plan or change the normal production app.

## Exact candidate

| Field | Value |
| --- | --- |
| Installation | `00bcc640-c430-4c9a-8d97-e35835b8bcf8` |
| Release | `1fd0e129-f000-4b68-8f4a-7720a3101346` |
| Version | `0.1.3` |
| Release digest | `c0f6ee10ff0c5cd9761b32a138af8a9f08e13d1ec10c490f73e8c1e95df45e4c` |
| Source digest | `8f00ea96d9392941c573a35e638a2650a882e36ea2b53355e9c1754bbd017f49` |
| Artifact digest | `9d1ec4de4d05e39109b460392a80ac6923f5391082b397c290cac8636e713bca` |
| Policy digest | `bbb12be60a2b38b498f7792d0038e763a8132c70597aef7cf38a54fa644312b9` |
| Guest image | `ebe5ce977a726130fd1aa90d2c853467bb6d143141ed07f74b7a06e98efd3912` |
| Helper digest | `804d68bd8d83ca817c6413eb3b2365216778aa26421c81fb3e9f3810b82dcb75` |
| Runner | `rootless-podman-v4` |
| Staged source | Root commit `47341ea65`; extension workspace revision 3 |
| Build operation | `b51721d3-8465-4790-8e52-ad89b9006c6c` |

## Change and evidence

The image now includes pinned Debian Git `1:2.39.5-0+deb12u3`. Its actual
Incus build passed a Git init, add, commit, and clean-status check as guest
UID 1000. The helper, backend permissions, network policy, and resource limits
remain the same. The presets use the new immutable image. Default limits are
4 GiB memory, 2 CPU equivalents, 1,024 PIDs, and 20 GiB disk.

The sealed extension build passed typecheck, compilation, adapter tests,
extension tests, manifest tests, and metadata discovery. Revision 2 failed
because its test read a file outside the sealed package. That failure remains
recorded; revision 3 moves repository parity checks to repository tests and
adds a real isolated-package regression.

The candidate has no ordinary extension permissions or new trusted endpoint.
Backend authority still comes from reviewed provider connections. Its fixture
qualification records are not live qualification of this candidate. Fresh
server qualification is required before workload admission.

Private evidence: `/root/ezh-qualification-stage/oct04-provider-013-candidate/verified-candidate-review.json`.
SHA-256: `61a197d1f5d47c2191826eef0d5404bdcfa5eb6fe17c832183af458adc3f977a`.
The root reviewer read and checked this evidence independently.

## Execution order

1. Record human approval of the exact digest above.
2. With the fixed host installed, prove activation is refused while the
   retained diagnostic guest still exists. Confirm the old release stays active.
3. Stop and dispose of that exact guest through EZHarness after its test files
   have been exported. Verify operation completion and resource release.
4. Activate the same approved candidate after the dependency check passes.
5. Prepare the actual new connection and its server plan for separate review.
   Do not use invented connection IDs or carry old qualification forward.

Keep the old release and immutable images for evidence. An unknown activation
or cleanup outcome stops further effects until read-only reconciliation resolves it.

Human review is required by `src/extensions/CLAUDE.md`:
“First-party code follows the same human approval boundary.”
