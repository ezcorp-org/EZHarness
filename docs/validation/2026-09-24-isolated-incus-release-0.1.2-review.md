# Isolated Incus provider release 0.1.2 review

Status: staged and verified in the isolated EZHarness app on 24 September 2026. This packet does not approve or activate the release. The Incus server was not changed by this release build.

The source is commit `e7da01193f5082e04f02fe7fc377b48101af80a8`. The staged `manifest.ts`, `manifest.test.ts`, `package.json`, and unchanged `README.md` each match that commit byte for byte. The source pins the [reviewed guest image 0.1.2](./2026-09-24-incus-guest-image-0.1.2-review.md) in both provider presets.

| Item | Exact value |
| --- | --- |
| Installation | `00bcc640-c430-4c9a-8d97-e35835b8bcf8` |
| Workspace | `5c744df1-2a3c-4737-a027-7fb343074225`, revision `4` |
| Source digest | `8076ab07036bc42ac07e9497a70f83baae84c1ef6d92fdc384bd29931978a6ea` |
| Build operation | `16748b7e-123e-4bcf-97bc-47fb7793b862`, `verified`, zero diagnostics |
| Candidate release | `9ec8e626-0a5d-4ed6-9333-a3fd1aa25472` |
| Release digest | `4c0e2eee0f9105d28a5173ec695bd42c6b84de58233570fb0ffb2dcf03a6ac18` |
| Artifact digest | `2fc8d4c91d0b8ec779451cc6ff0f8fc93e17ddec9085e0d632d65d9bde7008d5` |
| Runner image | `docker.io/oven/bun@sha256:e10577f0db68676a7024391c6e5cb4b879ebd17188ab750cf10024a6d700e5c4` |
| Runner profile | `rootless-podman-v4` |
| Guest image in both presets | `2f8868763f6cbec0452ab0d4db82ecb315c4aff1b9a3d2d1777cd878017e9fa1` |
| Guest helper in both presets | `804d68bd8d83ca817c6413eb3b2365216778aa26421c81fb3e9f3810b82dcb75` |
| Current active release | `02ce233e-ccbf-4b19-a93f-4e6ee63a926a` (0.1.1), generation `2` |

The v4 build finished at `2026-09-24T15:25:44.038Z`. Its catalog check is `verified`; no smoke test is declared. All six build checks passed: typecheck, compile, adapter test, extension test, manifest test, and metadata discovery. The host candidate fixtures for `incus-linux-exec-v1` and `incus-compose-v1` each passed cases SP01, SP02, SP03, SP05, SP07, and SP08. Their preset digests are `5b3ffe0b426820f6d484f65f1de2c33390e69be1cfc1190f07a68f3b14bdbd02` and `6129aa77e4fe900e01ac9bc5fdf994865dd2b795dbccca91d7837bee0ca3d7f0`, respectively. Both host fixtures were verified at `2026-09-24T15:25:43.588Z` and expire at `2026-09-24T16:25:43.588Z`.

These host fixtures check the provider contract. They do not prove live Incus qualification, guest creation through EZHarness, helper attestation, or nested Compose through the provider. The current live preflight remains closed at `helper_version_unverified`. Approval and activation require a separate review of this exact release and current evidence. No approval request, approval, activation, Incus server write, or guest creation was made for this packet.
