# First EZHarness-owned Incus guest: stopped smoke execution

Status at 2026-09-25 15:14 UTC: **EZHarness created one real Incus guest, but the smoke stopped before START because its saved CREATE became `OUTCOME_UNKNOWN`.** The guest remains stopped in project `ezharness`; the controller retains its reservation. No START, marker, Compose, STOP, DESTROY, second CREATE, changed image, or new operation ID was sent. This is not a completed lifecycle or provider qualification.

The user approved exactly one attempt under the [review packet](2026-09-25-next-incus-owned-guest-smoke-review.md), SHA-256 `16f082e42c805cd050860706fdf42b3c5af93c22928006473f2bc8aa87b2be11`, at repository HEAD `82467e5ac393de546c1f84c3504d77bfe929d07c`. The worktree was clean before the effect. All app calls used the retained human admin session, the held loopback origin, and exactly the route's six fields for `incus-smoke-owned-lifecycle-20260925-v1`. The TCP ingress hold remained in force.

## Fresh entry gates

The isolated app health/readiness and admin identity returned HTTP 200; the admin role was `admin`. Active Incus release `9ec8e626-0a5d-4ed6-9333-a3fd1aa25472`, generation 3, digest `4c0e2eee0f9105d28a5173ec695bd42c6b84de58233570fb0ffb2dcf03a6ac18`, verified setup `97edb3a1-80e4-4305-baac-1325930b868d`, and connection revision 1 matched the packet. The connection was unrevoked. The dedicated runner artifact retained SHA-256 `2fc8d4c91d0b8ec779451cc6ff0f8fc93e17ddec9085e0d632d65d9bde7008d5`; the server's `ezharness-guest-0-1-2` alias retained image fingerprint `2f8868763f6cbec0452ab0d4db82ecb315c4aff1b9a3d2d1777cd878017e9fa1` and the helper pin remained `804d68bd8d83ca817c6413eb3b2365216778aa26421c81fb3e9f3810b82dcb75`. The app's immutable Compose image reference remained the reviewed BusyBox digest.

The server listed zero project instances and active operations before CREATE. Its only `engine` client certificate was restricted to project `ezharness`, fingerprint `fcd2d46c8f4007cd01098123e6bfbfba0c962b1c9d9f511bf222dfb7a9b3e622`. Project limits were four containers, 32 GiB memory, eight CPUs, 4096 processes, and 80 GiB disk. The applied host admission capacity was 32 GiB, 8000 millicores, 4096 PIDs, 80 GiB, four slots; no reservation was active. Server memory availability was about 58.3 GB at the check.

Because the earlier ID readback was 43 minutes old, the supervisor was stopped again under the TCP hold. Port 4301 and all database handles were closed before a fresh PGlite copy; rsync checksums matched and the source inode did not change. The supervisor restarted with its pinned library path, and health/readiness/admin checks returned HTTP 200. Runner PID `3160354` was unchanged and the regular user's loopback access was still denied. The root-private SELECT-only readback at 15:09:16 UTC, SHA-256 `55662cad6a40b94425d8320ef73c42144fcdf96edca02cd40679243567f98594`, found no fixture, project, binding, operation, admission, reservation, or workspace row for the exact proposed ID and derived identity. The server inventory was still empty immediately before CREATE.

## One CREATE and its saved result

At 15:10:19 UTC, one `create` POST returned HTTP 202 with controller operation `ca4d3c6b-de37-4d2a-ba00-8a243fe3124d`, generation 1. At 15:10:23.778 UTC its saved state was `PROVIDER_PENDING`, with provider operation ID `incus-create-921bde75-bc6b-4758-90b4-d5f189ecee71`. Incus independently shows one non-ephemeral, **stopped** container created at 15:10:20.736 UTC: `ezh-3706fb480a240548bcf13974451b200d`. Its `user.ezharness.create_key` is the exact controller operation ID; its `sandbox_id` is `incus-qual-binding-668790ad210707f1ff64d9d6ec31ce28366c509a54ab893c4731a2e628d71c8d`; its connection, preset, profile, generation, and managed-by tags match this attempt. It uses the pinned base image and reviewed `compose` profile. Its configuration sets 4 GiB memory, 2000 millicores through `limits.cpu.allowance`, 1024 processes, and a 20 GiB root disk. These are configuration observations, not load-test proof.

At 15:10:38.874 UTC, read-only `status` reported the same CREATE as `OUTCOME_UNKNOWN`, with binding desired `STOPPED`, observed `UNKNOWN`. A second read returned the same state. The saved provider operation ID did not change. No later lifecycle action was admitted. A stopped-app, checksum-verified PGlite copy queried at 15:14:10 UTC found exactly one CREATE for this binding, state `OUTCOME_UNKNOWN`, `error_code` and `error_message` null, and no START or DESTROY. Its one admission remained `ADMITTED`; compute and disk reservations remained `RESERVED` for 4 GiB, 2000 millicores, 1024 PIDs, 20 GiB, one slot. The binding was not tombstoned. The private readback SHA-256 is `a40caeda57b5a9eb0e4c6771480538ef5b9a116f66574815d30863b9acd3b150`.

The server now lists no active Incus operations, and `incus operation show 921bde75-bc6b-4758-90b4-d5f189ecee71` returns `Operation not found`. The tagged stopped instance remains. The response boundary is clear: CREATE returned a provider operation receipt after the guest was created, but later provider-operation inspection did not yield a durable success receipt. Repository code in `src/infrastructure/incus-transport/lifecycle.ts` inspects the temporary `/1.0/operations/<UUID>` for an `incus-create-...` ID; `src/sandboxes/incus-dispatcher.ts` maps an inspection error, including `NOT_FOUND`, to `UNKNOWN`; `src/sandboxes/controller.ts` preserves that unknown outcome. **Inference:** the Incus operation became unavailable before successful reconciliation, while the durable instance tags were not used as fallback proof in this inspection path. The available logs do not record the exact HTTP result of the 15:10:36 provider inspection, so this mechanism is not proven as the only cause. The guest's tagged existence is proven independently.

## Hold state and evidence

After the readback, the isolated supervisor restarted at PID `3496470`; runner PID `3160354` remained active. Health, readiness, and authenticated admin identity returned HTTP 200. The recovery hold marker was absent, while the separate TCP ingress hold still denied the regular user. Incus still had one stopped matching guest and no active operations. No guest process or Compose service was started.

All detailed responses are root-private under `/root/ezh-qualification-stage/next-guest-smoke-20260925` (mode 0700); individual evidence files are mode 0600:

| Evidence | SHA-256 |
| --- | --- |
| `01-create.json` | `a1bec2a005f058dad4c65eb65b03a19ad356cabb9ea814a1e1a5c6324fd835e5` |
| `02-status-create.json` | `3f04cff00b254e3a50009cc701cdc9cf6b143ea5500e6d7eb5f05d9d118c980e` |
| `03-status-create.json` | `141ceb112f2073fc25c34da1153d264759c81ee2970a420f44b07b490534e530` |
| `04-status-unknown-confirm.json` | `20f86a7a90d9e5ecece29cd2736408e6f67e3c46f361701f1f041e7c9036af93` |
| `post-unknown-readback.json` | `a40caeda57b5a9eb0e4c6771480538ef5b9a116f66574815d30863b9acd3b150` |
| `server-readback.txt` | `158c6664fecc1411f9721d0a2678d323d1c12970c7ff67906a31d80cbcf4832c` |

The next step is a separate reviewed recovery of this **effectful** UNKNOWN CREATE, using the saved binding and exact server tags. Do not use the prior no-effect recovery path: this guest exists. Decide whether the controller can safely prove CREATE success from the durable, scoped instance and then resume the same fixture, or whether an authorized cleanup must settle it first. No new CREATE or speculative DESTROY should conceal the unresolved receipt.
