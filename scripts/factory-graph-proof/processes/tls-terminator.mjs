/**
 * A TLS-terminating sidecar in front of the pinned Temporal dev server.
 *
 * The orchestrator requires mutual TLS to its namespace and the Temporal CLI dev
 * server terminates no TLS of its own, so a deployment puts a terminator in
 * front of it. This one presents the installation's server certificate,
 * REQUIRES a client certificate signed by the same CA, and forwards bytes it
 * never reads. Ported from the W09b real-server harness.
 *
 * Usage: node tls-terminator.mjs <listen-port> <target-port> <secrets-dir>
 */
import { createServer } from "node:tls";
import { connect } from "node:net";
import { readFileSync } from "node:fs";

const [, , listenPort, targetPort, secrets] = process.argv;
const server = createServer({
  key: readFileSync(`${secrets}/server.key`),
  cert: readFileSync(`${secrets}/server.pem`),
  ca: readFileSync(`${secrets}/ca.pem`),
  requestCert: true,
  rejectUnauthorized: true,
  // Temporal speaks gRPC over HTTP/2.
  ALPNProtocols: ["h2"],
}, (socket) => {
  const upstream = connect(Number(targetPort), "127.0.0.1");
  socket.pipe(upstream);
  upstream.pipe(socket);
  const close = () => { socket.destroy(); upstream.destroy(); };
  for (const stream of [socket, upstream]) { stream.on("error", close); stream.on("close", close); }
});
server.listen(Number(listenPort), "127.0.0.1", () => console.log(`tls-terminator ${listenPort} -> ${targetPort}`));
