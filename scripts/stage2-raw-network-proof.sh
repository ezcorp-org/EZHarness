#!/usr/bin/env bash
# Run the production Stage 2 launcher in an owned Podman network namespace.
#
# The normal arm leaves the launcher-installed nft output policy in place. It
# must deny a direct TCP connection to the listener on the forbidden veth peer.
# The negative-control arm deletes only that nft table after launcher setup;
# its required deny assertion then exits 41 because the same connection works.

set -euo pipefail

mode="${1:---nft-on}"
case "$mode" in
  --nft-on|--nft-off) ;;
  *) echo "usage: $0 [--nft-on|--nft-off]" >&2; exit 64 ;;
esac

image="${EZCORP_STAGE2_PROOF_IMAGE:-localhost/ezcorp-extension-v4:terra-final-26541024}"
conmon="${CONMON:-/tmp/ez-audit-ci-conmon}"
script_dir="$(cd -- "$(dirname -- "$0")" && pwd)"
launcher="${EZCORP_STAGE2_PROOF_LAUNCHER:-$script_dir/../src/extensions/mcp-launcher.sh}"
if [ ! -f "$launcher" ]; then
  echo "missing production launcher source: $launcher" >&2
  exit 66
fi
launcher="$(cd -- "$(dirname -- "$launcher")" && pwd)/$(basename -- "$launcher")"

exec env CONMON="$conmon" podman run --rm --network=private --user 0 \
  --cap-add=NET_ADMIN --security-opt unmask=/proc/sys \
  -v "$launcher:/app/src/extensions/mcp-launcher.sh:ro" \
  -e "EZCORP_STAGE2_PROOF_MODE=$mode" \
  "$image" sh -eu -c '
bun run - <<"NODE"
const { createServer, connect } = require("node:net");
const { execFileSync, spawn } = require("node:child_process");
const { createHash } = require("node:crypto");
const { readFileSync } = require("node:fs");

const launcher = "/app/src/extensions/mcp-launcher.sh";
const listenerAddress = "10.42.0.2";
const listenerPort = 45873;
const peerName = "rawp0";
const hostName = "rawg0";
const mode = process.env.EZCORP_STAGE2_PROOF_MODE;

function command(command, args) {
  return execFileSync(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

function removeSetup() {
  try { command("nft", ["delete", "table", "inet", "mcp-egress"]); } catch {}
  try { command("ip", ["link", "delete", hostName]); } catch {}
}

function waitForDirectTcp() {
  return new Promise((resolve) => {
    const socket = connect({ host: listenerAddress, port: listenerPort });
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(result);
    };
    socket.once("connect", () => finish("CONNECTED"));
    socket.once("error", (error) => finish(error.code || String(error)));
    socket.setTimeout(850, () => finish("TIMEOUT"));
  });
}

async function main() {
  const sourceSha256 = createHash("sha256").update(readFileSync(launcher)).digest("hex");
  command("ip", ["link", "add", hostName, "type", "veth", "peer", "name", peerName]);
  command("ip", ["addr", "add", "10.42.0.2/24", "dev", peerName]);
  command("ip", ["link", "set", hostName, "up"]);
  command("ip", ["link", "set", peerName, "up"]);

  const listener = createServer((socket) => socket.end("ok"));
  await new Promise((resolve, reject) => {
    listener.once("error", reject);
    listener.listen(listenerPort, listenerAddress, resolve);
  });

  const probe = [
    "const { connect } = require(\"node:net\");",
    "if (process.env.EZCORP_STAGE2_PROOF_MODE === \"--nft-off\") require(\"node:child_process\").execFileSync(\"nft\", [\"delete\", \"table\", \"inet\", \"mcp-egress\"]);",
    "const socket = connect({ host: \"10.42.0.2\", port: 45873 });",
    "let done = false; const finish = (r) => { if (done) return; done = true; socket.destroy(); console.log(r); };",
    "socket.once(\"connect\", () => finish(\"CONNECTED\")); socket.once(\"error\", (e) => finish(e.code || String(e))); socket.setTimeout(850, () => finish(\"TIMEOUT\"));",
  ].join(" ");
  const child = spawn("sh", ["-c", "printf x | exec \"$@\"", "stage2-proof", "bash", launcher, "bun", "-e", probe], {
    env: {
      ...process.env,
      EZCORP_MCP_STAGE2_VETH_ENABLED: "1",
      EZCORP_MCP_VETH_PEER_NAME: peerName,
      EZCORP_MCP_VETH_IPV4: "10.42.0.3/30",
      EZCORP_MCP_PROXY_HOST_GATEWAY: "10.42.0.1:45874",
      EZCORP_MCP_BWRAP_ENABLED: "0",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const exit = await new Promise((resolve) => child.once("exit", (code) => resolve(code)));
  const result = stdout.trim().split(/\s+/).at(-1) || "NO_RESULT";
  const receipt = { mode, launcher, sourceSha256, listener: `${listenerAddress}:${listenerPort}`, childExit: exit, rawConnect: result, stderr: stderr.trim() };
  console.log(JSON.stringify(receipt));
  listener.close();
  removeSetup();
  if (exit !== 0) process.exit(43);
  if (result !== "CONNECTED") {
    if (mode === "--nft-on") process.exit(0);
    console.error("NEGATIVE_CONTROL_DID_NOT_CONNECT");
    process.exit(42);
  }
  console.error("DENY_ASSERTION_FAILED: forbidden raw TCP connected");
  process.exit(41);
}

main().catch((error) => {
  console.error(error.stack || String(error));
  removeSetup();
  process.exit(44);
});
NODE
'
