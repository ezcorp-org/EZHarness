import { readFileSync } from "node:fs";
import { request } from "node:https";

const input = JSON.parse(readFileSync(0, "utf8"));
const response = await new Promise((resolve, reject) => {
  const body = Buffer.from(input.body, "base64");
  const req = request(input.url, {
    method: input.method, ca: input.ca, cert: input.cert, key: input.key,
    servername: "localhost", rejectUnauthorized: true,
    headers: { ...input.headers, "content-length": body.length },
  }, response => {
    const chunks = [];
    response.on("data", chunk => chunks.push(chunk));
    response.on("error", reject);
    response.on("end", () => resolve({ status: response.statusCode, body: Buffer.concat(chunks).toString("base64") }));
  });
  req.setTimeout(5_000, () => req.destroy(new Error("private test request timed out")));
  req.on("error", reject);
  req.end(body);
});
console.log(JSON.stringify(response));
