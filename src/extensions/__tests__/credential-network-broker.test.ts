import { afterEach, expect, test } from "bun:test";
import { registerCallProvenance, releaseCallProvenance } from "../call-provenance";
import { clearExpiredCredentialHandles, handleCredentialBroker, injectCredentialHeaders } from "../credential-broker";
import { clearExpiredNetworkBodies, handleNetworkBroker } from "../network-broker";
import type { RpcHandlerDeps } from "../tool-executor/rpc-handlers";
import type { JsonRpcRequest } from "../types";

const tokens: string[] = [];
const names = ["OPENAI_API_KEY", "OPENAI_ACCESS_TOKEN", "GITHUB_TOKEN"];
function fixture(extensionId = "ext-a") {
  const token = registerCallProvenance({ actorExtensionId: extensionId, onBehalfOf: "user-a", conversationId: "conversation-a", runId: null, parentCallId: null, kind: "tool", ownerless: false });
  tokens.push(token);
  const state = { granted: true, allowed: true };
  const deps = { registry: { getGrantedPermissions: () => ({ env: state.granted ? names : [] }), getManifest: () => ({ permissions: { env: names } }) }, engine: { authorize: async () => ({ decision: state.allowed ? "allow" : "deny" }) } } as unknown as RpcHandlerDeps;
  const request = (method: string, params: Record<string, unknown> = {}): JsonRpcRequest => ({ jsonrpc: "2.0", id: "request", method, params: { ...params, _meta: { ezCallId: token } } });
  return { token, deps, request, state };
}
const network = { resolveHost: async () => ["93.184.216.34"], fetchImpl: async () => new Response("ok") };
afterEach(() => { for (const token of tokens.splice(0)) releaseCallProvenance(token); clearExpiredCredentialHandles(Date.now() + 61_000); clearExpiredNetworkBodies(Date.now() + 61_000); delete process.env.EZCORP_EXTENSION_INTERNAL_ORIGINS; });

test("env returns opaque scoped handles and rejects raw host env access", async () => {
  const { deps, request, state } = fixture();
  const result = await handleCredentialBroker(deps, "ext-a", request("ezcorp/env.get", { name: "OPENAI_API_KEY" }), { resolveCredential: async () => "host-secret" });
  expect(result.result).toMatch(/^ezcred_v4_[a-f0-9]{64}$/);
  expect(JSON.stringify(result)).not.toContain("host-secret");
  expect((await handleCredentialBroker(deps, "ext-a", request("ezcorp/env.get", { name: "DATABASE_URL" }))).error).toBeDefined();
  expect((await handleCredentialBroker(deps, "ext-a", request("ezcorp/env.get", { name: "GITHUB_TOKEN" }))).result).toBeNull();
  state.granted = false;
  expect((await handleCredentialBroker(deps, "ext-a", request("ezcorp/env.get", { name: "OPENAI_API_KEY" }))).error).toBeDefined();
  state.granted = true; state.allowed = false;
  expect((await handleCredentialBroker(deps, "ext-a", request("ezcorp/env.get", { name: "OPENAI_API_KEY" }))).error).toBeDefined();
});

test("credential substitution requires exact origin, active invocation and current grants", async () => {
  const first = fixture();
  let secret: string | null = "host-secret";
  const issued = await handleCredentialBroker(first.deps, "ext-a", first.request("ezcorp/env.get", { name: "OPENAI_API_KEY" }), { resolveCredential: async () => secret });
  const headers = new Headers({ authorization: `Bearer ${issued.result}` });
  const request = first.request("ezcorp/network.fetch");
  expect((await injectCredentialHeaders(first.deps, "ext-a", request, new URL("https://api.openai.com/v1/responses"), headers)).get("authorization")).toBe("Bearer host-secret");
  for (const url of ["https://evil.example/", "http://api.openai.com/", "https://api.openai.com:444/", "https://api.openai.com.evil.example/"]) await expect(injectCredentialHeaders(first.deps, "ext-a", request, new URL(url), headers)).rejects.toThrow("destination");
  const second = fixture();
  await expect(injectCredentialHeaders(second.deps, "ext-a", second.request("ezcorp/network.fetch"), new URL("https://api.openai.com"), headers)).rejects.toThrow("another invocation");
  await expect(injectCredentialHeaders(first.deps, "ext-b", request, new URL("https://api.openai.com"), headers)).rejects.toThrow("matching active");
  await expect(injectCredentialHeaders(first.deps, "ext-a", request, new URL("https://api.openai.com"), new Headers({ "x-key": String(issued.result) }))).rejects.toThrow("Authorization");
  await expect(injectCredentialHeaders(first.deps, "ext-a", request, new URL(`https://api.openai.com/?key=${issued.result}`), new Headers())).rejects.toThrow("Authorization");
  first.state.granted = false;
  await expect(injectCredentialHeaders(first.deps, "ext-a", request, new URL("https://api.openai.com"), headers)).rejects.toThrow("approved");
  first.state.granted = true; secret = null;
  await expect(injectCredentialHeaders(first.deps, "ext-a", request, new URL("https://api.openai.com"), headers)).rejects.toThrow("no longer");
  releaseCallProvenance(first.token);
  await expect(injectCredentialHeaders(first.deps, "ext-a", request, new URL("https://api.openai.com"), headers)).rejects.toThrow("matching active");
});

test("Codex account metadata stays host-side and path scope cannot expand", async () => {
  const { deps, request } = fixture();
  let secret = `header.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "account-a" } })).toString("base64url")}.signature`;
  const issued = await handleCredentialBroker(deps, "ext-a", request("ezcorp/env.get", { name: "OPENAI_ACCESS_TOKEN" }), { resolveCredential: async () => secret });
  const headers = new Headers({ authorization: `Bearer ${issued.result}` });
  const url = new URL("https://chatgpt.com/backend-api/codex/responses");
  expect((await injectCredentialHeaders(deps, "ext-a", request("ezcorp/network.fetch"), url, headers)).get("chatgpt-account-id")).toBe("account-a");
  await expect(injectCredentialHeaders(deps, "ext-a", request("ezcorp/network.fetch"), new URL("https://chatgpt.com/backend-api/other"), headers)).rejects.toThrow("destination");
  headers.set("chatgpt-account-id", "different");
  await expect(injectCredentialHeaders(deps, "ext-a", request("ezcorp/network.fetch"), url, headers)).rejects.toThrow("account header");
  secret = "not-a-jwt";
  await expect(injectCredentialHeaders(deps, "ext-a", request("ezcorp/network.fetch"), url, headers)).rejects.toThrow("metadata");
});

test("network never forwards host credentials through cross-origin redirects or back to extension", async () => {
  const { deps, request } = fixture();
  const issued = await handleCredentialBroker(deps, "ext-a", request("ezcorp/env.get", { name: "GITHUB_TOKEN" }), { resolveCredential: async () => "secret-github-token" });
  let calls = 0;
  const input = { url: "https://api.github.com/user", init: { headers: { authorization: `Bearer ${issued.result}` } } };
  const redirected = await handleNetworkBroker(deps, "ext-a", request("ezcorp/network.fetch", input), { ...network, fetchImpl: async (_url, init) => { calls++; expect(new Headers(init.headers).get("authorization")).toBe("Bearer secret-github-token"); return new Response(null, { status: 302, headers: { location: "https://evil.example/stolen" } }); } });
  expect(calls).toBe(1); expect(redirected.error?.message).toContain("redirect");
  const echoed = await handleNetworkBroker(deps, "ext-a", request("ezcorp/network.fetch", input), { ...network, fetchImpl: async () => new Response("secret-github-token") });
  expect(echoed.error?.message).toContain("protected credential");
  expect(JSON.stringify(echoed)).not.toContain("secret-github-token");
});

test("network body handles are ordered, bounded and invocation-specific", async () => {
  const { deps, request } = fixture();
  const result = await handleNetworkBroker(deps, "ext-a", request("ezcorp/network.fetch", { url: "https://example.com" }), { ...network, fetchImpl: async () => new Response(new Uint8Array(256 * 1024 + 5).fill(65)) });
  const bodyId = (result.result as { bodyId: string }).bodyId;
  expect(bodyId).toBeDefined();
  expect((await handleNetworkBroker(deps, "ext-a", request("ezcorp/network.read", { bodyId, offset: 1 }))).error).toBeDefined();
  const second = fixture();
  expect((await handleNetworkBroker(second.deps, "ext-a", second.request("ezcorp/network.read", { bodyId, offset: 0 }))).error).toBeDefined();
  const first = await handleNetworkBroker(deps, "ext-a", request("ezcorp/network.read", { bodyId, offset: 0 }));
  expect((first.result as { done: boolean }).done).toBe(false);
  const last = await handleNetworkBroker(deps, "ext-a", request("ezcorp/network.read", { bodyId, offset: 256 * 1024 }));
  expect((last.result as { done: boolean }).done).toBe(true);
  expect((await handleNetworkBroker(deps, "ext-a", request("ezcorp/network.read", { bodyId, offset: 0 }))).error).toBeDefined();
});

test("network rejects private targets, unapproved hosts, invalid inputs and uncertain mutation retries", async () => {
  const { deps, request, state } = fixture();
  for (const params of [{ url: "file:///etc/passwd" }, { url: "http://user:pass@example.com" }, { url: "https://example.com", init: { method: "TRACE" } }, { url: "https://example.com", init: { headers: { host: "evil" } } }, { url: "https://example.com", init: { body: "!" } }]) expect((await handleNetworkBroker(deps, "ext-a", request("ezcorp/network.fetch", params), network)).error).toBeDefined();
  expect((await handleNetworkBroker(deps, "ext-a", request("ezcorp/network.fetch", { url: "http://127.0.0.1" }), { ...network, resolveHost: async () => ["127.0.0.1"] })).error).toBeDefined();
  state.allowed = false;
  expect((await handleNetworkBroker(deps, "ext-a", request("ezcorp/network.fetch", { url: "https://example.com" }), network)).error).toBeDefined();
  state.allowed = true;
  let calls = 0;
  const result = await handleNetworkBroker(deps, "ext-a", request("ezcorp/network.fetch", { url: "https://example.com", init: { method: "POST" } }), { resolveHost: async () => ["93.184.216.34", "93.184.216.35"], fetchImpl: async () => { calls++; throw new Error("connection reset after write"); } });
  expect(calls).toBe(1); expect(result.error?.message).toContain("outcome_unknown");
  process.env.EZCORP_EXTENSION_INTERNAL_ORIGINS = '["http://127.0.0.1:8080"]';
  expect((await handleNetworkBroker(deps, "ext-a", request("ezcorp/network.fetch", { url: "http://127.0.0.1:8080" }), { ...network, resolveHost: async () => ["127.0.0.1"] })).result).toBeDefined();
});

test("concurrent network calls reserve bounded response capacity before reading", async () => {
  const { deps, request } = fixture();
  const complete: ((response: Response) => void)[] = [];
  const options = { ...network, fetchImpl: async () => new Promise<Response>(resolve => { complete.push(resolve); }) };
  const first = handleNetworkBroker(deps, "ext-a", request("ezcorp/network.fetch", { url: "https://example.com/a" }), options);
  const second = handleNetworkBroker(deps, "ext-a", request("ezcorp/network.fetch", { url: "https://example.com/b" }), options);
  while (complete.length < 2) await Bun.sleep(1);
  const third = await handleNetworkBroker(deps, "ext-a", request("ezcorp/network.fetch", { url: "https://example.com/c" }), network);
  expect(third.error?.message).toContain("capacity");
  for (const finish of complete) finish(new Response("ok"));
  expect((await first).result).toBeDefined(); expect((await second).result).toBeDefined();
});

test("same-origin redirects cannot expand Codex credential path scope", async () => {
  const { deps, request } = fixture();
  const secret = `header.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "account-a" } })).toString("base64url")}.signature`;
  const issued = await handleCredentialBroker(deps, "ext-a", request("ezcorp/env.get", { name: "OPENAI_ACCESS_TOKEN" }), { resolveCredential: async () => secret });
  let calls = 0;
  const response = await handleNetworkBroker(deps, "ext-a", request("ezcorp/network.fetch", { url: "https://chatgpt.com/backend-api/codex/responses", init: { headers: { authorization: `Bearer ${issued.result}` } } }), { ...network, fetchImpl: async () => { calls++; return new Response(null, { status: 302, headers: { location: "/backend-api/accounts" } }); } });
  expect(calls).toBe(1); expect(response.error?.message).toContain("destination");
  clearExpiredCredentialHandles(Date.now() + 61_000);
  await expect(injectCredentialHeaders(deps, "ext-a", request("ezcorp/network.fetch"), new URL("https://chatgpt.com/backend-api/codex/responses"), new Headers({ authorization: `Bearer ${issued.result}` }))).rejects.toThrow("expired");
});
