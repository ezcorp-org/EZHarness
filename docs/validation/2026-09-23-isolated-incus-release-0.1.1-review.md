# Isolated Incus release 0.1.1 review

This is a new v4 provider release in the isolated test app. It has not been approved or activated. It changes no Incus server resource.

| Item | Exact value |
| --- | --- |
| Installation | `00bcc640-c430-4c9a-8d97-e35835b8bcf8` |
| Release | `02ce233e-ccbf-4b19-a93f-4e6ee63a926a` |
| Release digest | `dcde361cc4fe348743c1aafc5272ac5104b025046b1c96273e58dc0b8d6e8bdd` |
| Pending approval | `0c634e40-9a21-4d2c-9e03-a0d79dc349b7` |
| Source revision | `3`, digest `b19a6290baa7625626cb0b59efed1118283c3386817829e8f86162b5e4035705` |
| Current active release | `0c3bf486-149f-4411-8f17-e4defe0c905e`, generation `1` |
| Published guest image | `57c0d028e4456a3847fb9822802d6a8f613ba4e6ef03002999e8c957a1f40c6c` |
| Guest helper | `804d68bd8d83ca817c6413eb3b2365216778aa26421c81fb3e9f3810b82dcb75` |

The source change pins the published guest image in both declared presets, updates the release version to `0.1.1`, and adds pin tests and review text. The earlier active release declares an all-zero image digest and cannot pass live qualification. The new candidate build is `verified` with no diagnostics. Its host candidate fixtures passed for both presets and expire at `2026-09-24T00:02:23.617Z`; these are contract checks, not live server qualification.

Approval would activate this exact release in the isolated app. It does not authorize any server write. After activation, EZHarness must create a **new** operator plan bound to this release and a new connection certificate. The previous approved setup digest `adc0a93ba4a18122ca98ad50f387b06954819b7af8d2ca5f2dfcd039e7a6fb5b` is obsolete and must not be applied. The new plan and digest require their own review before Apply.
