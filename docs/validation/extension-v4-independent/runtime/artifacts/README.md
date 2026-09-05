# Invocation runtime receipt bundle

Archive: `invocation-runtime-receipts.tar.gz`

SHA-256: `0b445837c26edcf2cb39cd5e449ae8b35d01c98a39530531fd12c9a6ab693e4d`

Source candidate for red/green repair: `3093a3a5e327b5ca6fb585b9f1271817553804e8`, tree `e7d774a0d81983060dc60c2b92b9393ba464b05c`, base `537f074e7303ecdf3cbef1a7af4fd60a3244b0a3`.

Repair commit: `1fdf454d`. Integrated equivalent: `ddd024e5`.

Deterministic rootless follow-up: `d00629a6`. Integrated equivalent: `691f4135`.

All executable receipts use `/tmp/ez-extension-bun-1.3.14/bun-linux-x64/bun`, version 1.3.14.

Contents:

- `ez-runtime-audit-root-install.log`: first root frozen install, exit 0.
- `ez-runtime-audit-web-install.log`: first web frozen install, exit 0.
- `ez-runtime-sdk-served-red.log`: served protocol before repair, 8 pass and 2 fail.
- `ez-runtime-sdk-served-green4.log`: targeted SDK after repair, 22 pass and 0 fail.
- `ez-runtime-rootless-lifetime-fault-red.log`: controlled original-code fault, 0 pass and 1 fail.
- `ez-runtime-rootless-lifetime-fault-restored-green.log`: restored rootless result, 1 pass and 0 fail.
- `ez-runtime-sdk-default.log`: SDK default, 1,028 pass, 1 opt-in skip, 0 fail.
- `ez-runtime-sdk-mcp-optin.log`: networkless rootless MCP opt-in, 7 pass and 0 fail.
- `ez-runtime-sdk-build-final.log`: final SDK declaration build, exit 0.
- `ez-runtime-sdk-lint.log`: initial scoped lint receipt. It records one warning that was removed. The later direct scoped check reported no diagnostics before commit.

The bundle contains test output only. It contains no credential values or live-service payloads.
