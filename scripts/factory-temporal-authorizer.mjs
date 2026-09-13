const expectedIssuer = "ezcorp-factory-local";
const expectedAudience = "ezcorp-temporal";

function payload(token) {
  const encoded = token.split(".")[1];
  if (!encoded) return undefined;
  try { return JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")); }
  catch { return undefined; }
}

function certificateSubject(xfcc) { return /Subject="CN=([^,"]+)"/.exec(xfcc)?.[1]; }

export function authorize(headers) {
  const token = headers.get("authorization")?.replace(/^Bearer\s+/i, "");
  const claims = token && payload(token);
  const certificate = certificateSubject(headers.get("x-forwarded-client-cert") ?? "");
  const permissions = Array.isArray(claims?.permissions) ? claims.permissions : [];
  const identityPermission = certificate === "factory-control" ? "admin:temporal-system" : `admin:${certificate}`;
  return Boolean(certificate && claims?.sub === certificate && claims.iss === expectedIssuer && (claims.aud === expectedAudience || claims.aud?.includes(expectedAudience)) && Number.isInteger(claims.exp) && claims.exp > Math.floor(Date.now() / 1000) && permissions.includes(identityPermission));
}

if (import.meta.main) Bun.serve({
  port: 17445,
  fetch(request) {
    const allowed = authorize(request.headers);
    console.log(`temporal identity binding ${allowed ? "allowed" : "denied"}`);
    return allowed ? new Response(null, { status: 200 }) : new Response("certificate and JWT claims must match", { status: 403 });
  },
});
