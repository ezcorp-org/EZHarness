# Incus 0.1.4: exact release approval packet

The isolated host built and verified this release through the normal v4 workspace API. It is not active. Provider0.1.3 remains active, generation4. No guest was created by this build.

| Identity | Exact value |
|---|---|
| Installation | `00bcc640-c430-4c9a-8d97-e35835b8bcf8` |
| Verified release | `792beac5-3649-4843-8d6b-79870a92045b` |
| Release digest | `da8a359a5306d588499084354a578d5e454dbb03029b1fa8ee9ee1ba952926fd` |
| Source digest | `5e1f319086e83cf5fe818ea272ba57d4499cc3c90f26d93e9869b0c380afbed6` |
| Live artifact digest | `fd6bf95741aaaad6175492282f7efdb55b0abd49dc047f0a8c6c911ae59786b1` |
| Workspace/revision | `cd35c8b4-b713-4ec6-b67d-9ee6d5a43a8b` / `2` |
| Build operation | `a8b1bde0-1f8b-4d77-a518-a0ebc61e8a1d` |
| Previous active release | `1fd0e129-f000-4b68-8f4a-7720a3101346` / `0.1.3` |
| Runner | `rootless-podman-v4` |
| Runner image | `docker.io/oven/bun@sha256:e10577f0db68676a7024391c6e5cb4b879ebd17188ab750cf10024a6d700e5c4` |
| Runner policy digest | `bbb12be60a2b38b498f7792d0038e763a8132c70597aef7cf38a54fa644312b9` |

Six live builder checks passed: typecheck, compile, adapter tests, extension tests, manifest tests, and metadata discovery. Validator: `runner-v4.1`. Manifest requires host4.1. Requested extension grants are empty. The provider still uses the host-owned protected Incus transport and host policy/capacity checks.

The installed app is source `3fe533583bb71e4db339da80476cf39d27064086`, bundle manifest `0d3e5d06298bb11f4a223377070ced8fd0f905f19008575ec409b1cbb9132944`. Production host/provider code matches candidate `28c9981a287367cb551d41d67032c6c219a16f07`; later changes are recovery utilities, tests, and documents. No app replacement was needed for this build.

The independent offline build used the same locked source. Its artifact `3c9c629dfbc298bbb8ba03cc0bcfab84bc77b1f72e8977a2189d7645dab2c415` differs from the live artifact. Only `.runner/extension.js` and `.runner/recipe.json` differ. Recipe difference: provisioned SDK digest, offline `22b60a314676bf70dfe115a5a7dd7539b2451cca237e7ba4739dbf6f016ec545`, live `accd3d470dc7fbfdb1b26766c174d94cfe6285348284585bfe76e1218154737f`. Controlled reproduction with the same source proved host Bun1.4.2 produces the offline SDK and pinned host Bun1.3.14 produces the exact live SDK. Source files, runner image, limits, seccomp, and toolchain match. Approval must name the live release/artifact above; the compiled artifacts are not claimed identical.

Fresh preparation checks: server normal generationwwip, Btrfs pool Created, pinned guest imageebe5 available, scoped instance count0. Previous retained cleanup8157 succeeded; its reservations are released. Original069a remains UNKNOWN. The ingress hold remains installed. The temporary staging API key was revoked and the old bearer returned401. Normal isolated runner/app remain healthy; no new guest effects were submitted.

Activation sequence after human approval and a valid normal session:

1. Reinspect this exact release and unchanged active1fd0; refuse drift. Require no live bindings, provider operations, or reservations that block draining the old provider.
2. Request approval through `extensions_release`, action `requestApproval`, exact release792beac5 and expected active1fd0. Save the actual returned approval ID.
3. A human session answers that exact approval through `POST /api/extensions/releases/00bcc640-c430-4c9a-8d97-e35835b8bcf8/approve`, `{approvalId, decision:true}`. No bearer or source-lock approval substitute.
4. Activate through the normal `extensions_release` action `activate` with that approved ID and one new idempotency key. Inspect the completed operation and new active generation before any fixture operation.
5. Create fresh environment/policy/capacity/qualification records for this release, then run the real native sandbox flow and10 cycles. Do not retarget the old connection or replay old recovery requests.

These builder checks and host fixture qualifications do not prove the real native sandbox flow. Final lifecycle qualification remains pending. This request is for isolated provider activation and qualification, not merge or public release.

Private immutable evidence: `/root/ezh-qualification-stage/oct05-final-qualification/06-inspect-build-response.json`, SHA256 `d5767d92964c62332739bbccd769ac0eb9068433d6fbf7691b4441a0ddb1dc3f`. Credential files remain root-private and are not part of this packet.
