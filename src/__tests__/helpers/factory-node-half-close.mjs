import { readFileSync } from "node:fs";
import { connect } from "node:tls";
const input = JSON.parse(readFileSync(0, "utf8"));
const endpoint = new URL(input.url);
const result = await new Promise(resolve => {
  let received = false;
  let heartbeat;
  let timer;
  let settled = false;
  const socket = connect({ host: "127.0.0.1", port: Number(endpoint.port), ca: input.ca, cert: input.cert, key: input.key, servername: "localhost", rejectUnauthorized: true, allowHalfOpen: true });
  const finish = closedByServer => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    clearInterval(heartbeat);
    socket.destroy();
    resolve({ received, closedByServer });
  };
  socket.on("error", () => finish(true));
  socket.on("close", () => finish(true));
  socket.on("data", () => { received = true; });
  socket.on("end", () => { heartbeat = setInterval(() => socket.write("unwanted data"), 10); });
  socket.once("secureConnect", () => { timer = setTimeout(() => finish(false), 500); socket.write("GET / HTTP/1.1\r\nhost: localhost\r\n\r\n"); });
});
console.log(JSON.stringify(result));
