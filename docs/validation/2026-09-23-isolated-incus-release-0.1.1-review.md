# Isolated Incus release 0.1.1 review

This v4 provider release was approved and activated in the isolated test app on 23 September 2026. Activation operation `0caf1629-2191-4744-ae5d-c73270766689` reached `active` with no diagnostics. It changed no Incus server resource.

| Item | Exact value |
| --- | --- |
| Installation | `00bcc640-c430-4c9a-8d97-e35835b8bcf8` |
| Release | `02ce233e-ccbf-4b19-a93f-4e6ee63a926a` |
| Release digest | `dcde361cc4fe348743c1aafc5272ac5104b025046b1c96273e58dc0b8d6e8bdd` |
| Approved review | `0c634e40-9a21-4d2c-9e03-a0d79dc349b7` |
| Source revision | `3`, digest `b19a6290baa7625626cb0b59efed1118283c3386817829e8f86162b5e4035705` |
| Current active release | `0c3bf486-149f-4411-8f17-e4defe0c905e`, generation `1` |
| Published guest image | `57c0d028e4456a3847fb9822802d6a8f613ba4e6ef03002999e8c957a1f40c6c` |
| Guest helper | `804d68bd8d83ca817c6413eb3b2365216778aa26421c81fb3e9f3810b82dcb75` |

The source change pins the published guest image in both declared presets, updates the release version to `0.1.1`, and adds pin tests and review text. The earlier active release declares an all-zero image digest and cannot pass live qualification. The new candidate build is `verified` with no diagnostics. Its host candidate fixtures passed for both presets and expire at `2026-09-24T00:02:23.617Z`; these are contract checks, not live server qualification.

This approval activated only the exact release in the isolated app. It did not authorize a server write. The first setup plan failed at project creation because Incus 6.0.6 rejected one project key. The [revised operator setup plan](./2026-09-23-isolated-incus-setup-plan-0.1.1-revised-review.md) records the changed digest and requires its own approval before Apply. Earlier setup digests are obsolete and must not be retried.
