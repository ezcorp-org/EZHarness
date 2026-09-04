#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"
: "${EZ_EXTENSION_RUNNER_SOCKET:?Set a private test runner socket path}"
: "${EZ_EXTENSION_RUNNER_TOKEN_FILE:?Set a private test credential file}"
: "${EZ_EXTENSION_RUNNER_STORE:?Set a private test artifact store}"
export EZ_EXTENSION_APP_UID="${EZ_EXTENSION_APP_UID:-$(id -u)}"
if [[ ! -f "$EZ_EXTENSION_RUNNER_TOKEN_FILE" ]]; then
  bun -e 'import { randomBytes } from "node:crypto"; import { mkdir, lstat, writeFile } from "node:fs/promises"; import { dirname } from "node:path"; const path=process.env.EZ_EXTENSION_RUNNER_TOKEN_FILE; const directory=dirname(path); await mkdir(directory,{recursive:true,mode:0o700}); const status=await lstat(directory); if(!status.isDirectory() || status.isSymbolicLink() || status.uid!==process.getuid() || (status.mode&0o077)!==0) throw new Error("Credential directory must be private and owned by test user"); await writeFile(path, randomBytes(32).toString("hex"), { mode: 0o600, flag: "wx" });'
fi
exec bun packages/@ezcorp/extension-runner/src/main.ts
