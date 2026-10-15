/**
 * A TLS-terminating sidecar in front of the pinned Temporal server, for the
 * `factory-services` stack.
 *
 * C01 requires the orchestrator to reach an AUTHENTICATED Temporal namespace,
 * and `FactoryOrchestratorProcessConfig` therefore requires mutual-TLS material
 * and an API key with no non-TLS path. The Temporal dev server terminates
 * no TLS of its own, so the stack puts a terminator in front of it rather than
 * relaxing the product's requirement.
 *
 * The terminator is a real one: it presents this installation's server
 * certificate, REQUIRES a client certificate, and verifies it against the same
 * CA, so the orchestrator's connection is authenticated end to end on its own
 * side of the hop. It forwards bytes and reads none.
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
  // Temporal speaks gRPC over HTTP/2; without this the client and the
  // terminator negotiate HTTP/1.1 and every call fails at the first frame.
  ALPNProtocols: ["h2"],
}, (socket) => {
  const upstream = connect(Number(targetPort), "127.0.0.1");
  socket.pipe(upstream);
  upstream.pipe(socket);
  const close = () => { socket.destroy(); upstream.destroy(); };
  for (const stream of [socket, upstream]) { stream.on("error", close); stream.on("close", close); }
});
server.listen(Number(listenPort), "127.0.0.1", () => console.log(`tls-terminator ${listenPort} -> ${targetPort}`));
