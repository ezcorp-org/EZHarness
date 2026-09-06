import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { createServer, connect } = require("node:net");
const { execFileSync, spawn } = require("node:child_process");
const { createHash } = require("node:crypto");
const { closeSync, mkdtempSync, openSync, readFileSync, readlinkSync, rmSync, writeFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");

const launcher = "/app/src/extensions/mcp-launcher.sh";
const listenerAddress = "10.42.0.2";
const listenerPort = 45873;
const bridge = "s2br0";
const childHost = "s2ch0";
const childPeer = "s2cp0";
const forbiddenHost = "s2fh0";
const forbiddenPeer = "s2fp0";
const mode = process.env.EZCORP_STAGE2_PROOF_MODE;
let child;
let listener;
const listenerSockets = new Set();
let acceptedConnections = 0;
let tempDir;
let handshakeFd;
let executedLauncher = launcher;
let faultDisableCommandsRemoved = [];
let proxy;
let upstream;
const upstreamSockets = new Set();
let upstreamConnections = 0;
const policyHosts = [];
const allowedHost = "93.184.216.34";
const deniedHost = "93.184.216.35";
const echoMarker = "stage2-owned-proxy-output";

function command(file, args) {
  return execFileSync(file, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

function cleanup() {
  if (child && child.exitCode === null) child.kill("SIGKILL");
  if (handshakeFd !== undefined) closeSync(handshakeFd);
  try { command("nft", ["delete", "table", "inet", "mcp-egress"]); } catch {}
  try { command("ip", ["link", "delete", bridge]); } catch {}
  if (tempDir) rmSync(tempDir, { recursive: true, force: true });
}

function proxyRequest(hostname, token, expectEcho = false) {
  return new Promise((resolve, reject) => {
    const socket = connect({ host: "10.42.0.1", port: Number(process.env.STAGE2_PROXY_PORT) });
    let received = "";
    let sentEcho = false;
    const finish = (error, result) => {
      socket.destroy();
      if (error) reject(error);
      else resolve(result);
    };
    socket.setTimeout(3_000, () => finish(new Error("Proxy request timed out")));
    socket.once("error", error => finish(error));
    socket.once("connect", () => socket.write(
      "CONNECT " + hostname + ":" + process.env.STAGE2_UPSTREAM_PORT + " HTTP/1.1\r\n" +
      "Proxy-Authorization: Basic " + Buffer.from("_:" + token).toString("base64") + "\r\n\r\n",
    ));
    socket.on("data", chunk => {
      received += chunk.toString();
      const boundary = received.indexOf("\r\n\r\n");
      if (boundary < 0) return;
      const status = received.split("\r\n", 1)[0];
      if (!expectEcho || status !== "HTTP/1.1 200 Connection Established") return finish(null, { status });
      if (!sentEcho) { sentEcho = true; socket.write(echoMarker); }
      if (received.slice(boundary + 4) === echoMarker) finish(null, { status, output: echoMarker });
    });
    socket.once("close", () => {
      if (!received.includes("\r\n\r\n")) reject(new Error("Proxy closed without an HTTP response"));
    });
  });
}

async function childProbe() {
  const token = process.env.STAGE2_PROXY_TOKEN;
  const responses = {
    wrong: await proxyRequest(allowedHost, "wrong-token"),
    denied: await proxyRequest(deniedHost, token),
    allowed: await proxyRequest(allowedHost, token, true),
  };
  if (responses.wrong.status !== "HTTP/1.1 407 Proxy Authentication Required" ||
      responses.denied.status !== "HTTP/1.1 403 Forbidden" ||
      responses.allowed.status !== "HTTP/1.1 200 Connection Established" ||
      responses.allowed.output !== echoMarker) throw new Error("Production proxy authentication, policy or data flow failed");
  let rawConnect = null;
  let ipv6 = null;
  if (mode.startsWith("--ipv6")) {
    const route = require("node:child_process").spawnSync("ip", ["-6", "route", "get", "fd00:42::1"], { encoding: "utf8" });
    ipv6 = {
      eth0Disable: readFileSync("/proc/sys/net/ipv6/conf/eth0/disable_ipv6", "utf8").trim(),
      loDisable: readFileSync("/proc/sys/net/ipv6/conf/lo/disable_ipv6", "utf8").trim(),
      eth0HasSeed: command("ip", ["-6", "addr", "show", "dev", "eth0"]).includes("fd00:42::2"),
      loHasSeed: command("ip", ["-6", "addr", "show", "dev", "lo"]).includes("fd00:42::1"),
      routeExit: route.status, routeStderr: route.stderr.trim(), routeStdout: route.stdout.trim(),
    };
  } else {
    if (mode === "--nft-off") command("nft", ["delete", "table", "inet", "mcp-egress"]);
    rawConnect = await new Promise(resolve => {
      const socket = connect({ host: listenerAddress, port: listenerPort });
      const finish = result => { socket.destroy(); resolve(result); };
      socket.once("connect", () => finish("CONNECTED"));
      socket.once("error", error => finish(error.code));
      socket.setTimeout(850, () => finish("TIMEOUT"));
    });
  }
  console.log(JSON.stringify({ rawConnect, ipv6, proxy: responses }));
}

function waitForChildNetns(pid) {
  const parentNetns = readlinkSync("/proc/self/ns/net");
  const deadline = Date.now() + 3_000;
  return new Promise((resolve, reject) => {
    const poll = () => {
      if (Date.now() >= deadline) return reject(new Error(`child ${pid} did not enter a network namespace`));
      try {
        if (readlinkSync(`/proc/${pid}/ns/net`) !== parentNetns) return resolve();
      } catch (error) {
        return reject(new Error(`child ${pid} exited before namespace setup: ${error}`));
      }
      setImmediate(poll);
    };
    poll();
  });
}

function childExit(child) {
  return new Promise((resolve) => child.once("exit", (code, signal) => resolve({ code, signal })));
}

async function closeListener() {
  for (const socket of listenerSockets) socket.destroy();
  await new Promise((resolve) => listener.close(resolve));
}

async function main() {
  const sourceSha256 = createHash("sha256").update(readFileSync(launcher)).digest("hex");
  tempDir = mkdtempSync(join(tmpdir(), "stage2-raw-"));
  if (mode === "--ipv6-off") {
    const source = readFileSync(launcher, "utf8");
    let faultSource = source;
    for (const iface of ["eth0", "lo"]) {
      const command = "  printf '1\\n' > /proc/sys/net/ipv6/conf/" + iface + "/disable_ipv6";
      if (faultSource.split(command).length !== 2) throw new Error("Expected one IPv6 disable command for " + iface);
      faultSource = faultSource.replace(command, "  :");
    }
    executedLauncher = join(tempDir, "launcher-without-ipv6-disable.sh");
    writeFileSync(executedLauncher, faultSource, { mode: 0o755 });
    faultDisableCommandsRemoved = ["eth0.disable_ipv6", "lo.disable_ipv6"];
  }
  const handshake = join(tempDir, "handshake");
  command("mkfifo", [handshake]);
  handshakeFd = openSync(handshake, "r+");

  command("ip", ["link", "add", bridge, "type", "bridge"]);
  command("ip", ["addr", "add", "10.42.0.1/24", "dev", bridge]);
  command("ip", ["link", "set", bridge, "up"]);
  command("ip", ["link", "add", childHost, "type", "veth", "peer", "name", childPeer]);
  command("ip", ["link", "set", childHost, "master", bridge]);
  command("ip", ["link", "set", childHost, "up"]);
  command("ip", ["link", "add", forbiddenHost, "type", "veth", "peer", "name", forbiddenPeer]);
  command("ip", ["link", "set", forbiddenHost, "master", bridge]);
  command("ip", ["link", "set", forbiddenHost, "up"]);
  command("ip", ["addr", "add", "10.42.0.2/24", "dev", forbiddenPeer]);
  command("ip", ["link", "set", forbiddenPeer, "up"]);

  listener = createServer((socket) => {
    acceptedConnections += 1;
    listenerSockets.add(socket);
    socket.once("close", () => listenerSockets.delete(socket));
    socket.end("ok");
  });
  await new Promise((resolve, reject) => {
    listener.once("error", reject);
    listener.listen(listenerPort, listenerAddress, resolve);
  });

  const { createMcpProxy } = await import("../../src/extensions/mcp-proxy.ts");
  command("ip", ["addr", "add", allowedHost + "/32", "dev", "lo"]);
  upstream = createServer(socket => {
    upstreamConnections += 1;
    upstreamSockets.add(socket);
    socket.once("close", () => upstreamSockets.delete(socket));
    socket.on("data", chunk => socket.write(chunk));
  });
  await new Promise((resolve, reject) => {
    upstream.once("error", reject);
    upstream.listen(0, allowedHost, resolve);
  });
  proxy = createMcpProxy({
    extensionId: "stage2-owned-proof", extensionName: "stage2-owned-proof",
    conversationId: null, userId: null, permittedHosts: [allowedHost],
    bindAddress: "127.0.0.1:0",
    engine: { authorize: async (_context, capabilities) => {
      const hostname = capabilities[0]?.value;
      policyHosts.push(hostname);
      return { decision: hostname === allowedHost ? "allow" : "deny", auditId: "stage2-controlled-policy", reason: "controlled destination policy" };
    } },
  });
  await proxy.startAdditionalListener("10.42.0.1");
  const proxyUrl = new URL(proxy.proxyUrl());
  const payload = mode.startsWith("--ipv6")
    ? ["bash", "-c", "read -r -n 1 seed; ip -6 addr add fd00:42::2/64 dev s2cp0 nodad; ip -6 addr add fd00:42::1/128 dev lo nodad; ip link set lo up; exec \"$@\"", "ipv6-seed", "bash", executedLauncher, "bun", import.meta.filename]
    : ["bash", executedLauncher, "bun", import.meta.filename];
  child = spawn("sh", ["-c", "exec 0< \"$1\"; shift; exec \"$@\"", "stage2-proof", handshake, "unshare", "-U", "-n", "-m", "--map-root-user", "--", ...payload], {
    env: {
      ...process.env,
      EZCORP_MCP_STAGE2_VETH_ENABLED: "1",
      EZCORP_MCP_VETH_PEER_NAME: childPeer,
      EZCORP_MCP_VETH_IPV4: "10.42.0.6/30",
      EZCORP_MCP_PROXY_HOST_GATEWAY: "10.42.0.1:" + proxyUrl.port,
      STAGE2_PROXY_PORT: proxyUrl.port,
      STAGE2_PROXY_TOKEN: proxyUrl.password,
      STAGE2_UPSTREAM_PORT: String(upstream.address().port),
      EZCORP_STAGE2_PROOF_CHILD: "1",
      EZCORP_MCP_BWRAP_ENABLED: "0",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  await waitForChildNetns(child.pid);
  command("ip", ["link", "set", childPeer, "netns", String(child.pid)]);
  writeFileSync(handshakeFd, mode.startsWith("--ipv6") ? "xx" : "x");
  // The launcher reopens /dev/stdin. Keep the FIFO writer alive until the
  // child exits so that open cannot wait for a new writer after the byte.
  const exit = await childExit(child);
  const output = stdout.trim().split("\n").at(-1) || "NO_RESULT";
  if (exit.code !== 0 || exit.signal !== null) throw new Error("Stage2 child failed: " + stderr);
  const { rawConnect, ipv6, proxy: proxyResponses } = JSON.parse(output);
  await proxy.stop();
  for (const socket of upstreamSockets) socket.destroy();
  await new Promise(resolve => upstream.close(resolve));
  if (upstreamConnections !== 1 || policyHosts.join(",") !== deniedHost + "," + allowedHost) throw new Error("Proxy bypassed destination policy or opened an unexpected upstream connection");
  await closeListener();
  const receipt = { mode, launcher, sourceSha256, listener: `${listenerAddress}:${listenerPort}`, childPid: child.pid, childExit: exit.code, childSignal: exit.signal, rawConnect, ipv6, faultDisableCommandsRemoved, proxy: proxyResponses, upstreamConnections, policyHosts, acceptedConnections, openConnections: listenerSockets.size, stderr: stderr.trim() };
  console.log(JSON.stringify(receipt));
  cleanup();
  if (exit.code !== 0 || exit.signal !== null) process.exit(43);
  if (mode === "--ipv6-on" && ipv6.eth0Disable === "1" && ipv6.loDisable === "1" && !ipv6.eth0HasSeed && !ipv6.loHasSeed && ipv6.routeExit !== 0 && /network is unreachable/i.test(ipv6.routeStderr)) process.exit(0);
  if (mode === "--ipv6-off" && ipv6.eth0Disable !== "1" && ipv6.loDisable !== "1" && ipv6.eth0HasSeed && ipv6.loHasSeed && ipv6.routeExit === 0) {
    console.error("IPV6_ASSERTION_FAILED: removing only disable commands preserved IPv6 routing");
    process.exit(51);
  }
  if (mode === "--nft-on" && rawConnect === "TIMEOUT" && acceptedConnections === 0 && listenerSockets.size === 0) process.exit(0);
  if (mode === "--nft-off" && rawConnect === "CONNECTED" && acceptedConnections === 1 && listenerSockets.size === 0) {
    console.error("DENY_ASSERTION_FAILED: forbidden raw TCP connected");
    process.exit(41);
  }
  console.error(`UNEXPECTED_RAW_PROOF_RESULT: ${JSON.stringify(receipt)}`);
  process.exit(42);
}

(process.env.EZCORP_STAGE2_PROOF_CHILD === "1" ? childProbe() : main()).catch((error) => {
  console.error(error.stack || String(error));
  cleanup();
  process.exit(44);
});
