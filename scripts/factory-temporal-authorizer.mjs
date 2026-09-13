const denied = () => new Response("certificate and JWT subject must match", { status: 403 });

function subject(token) {
  const encoded = token.split(".")[1];
  if (!encoded) return undefined;
  try { return JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")).sub; }
  catch { return undefined; }
}

function certificateSubject(xfcc) {
  return /Subject="CN=([^,"]+)"/.exec(xfcc)?.[1];
}

Bun.serve({
  port: 17445,
  fetch(request) {
    const token = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
    const certificate = certificateSubject(request.headers.get("x-forwarded-client-cert") ?? "");
    const allowed = token && certificate && subject(token) === certificate;
    console.log(`temporal identity binding ${allowed ? "allowed" : "denied"}: jwt=${subject(token ?? "")} cert=${certificate}`);
    return allowed ? new Response(null, { status: 200 }) : denied();
  },
});
