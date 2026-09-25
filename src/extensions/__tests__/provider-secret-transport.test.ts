import { afterEach, expect, test } from "bun:test";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { FramedExecution } from "@ezcorp/extension-runner";
import * as ordinaryRunner from "@ezcorp/extension-runner";
import { SENSITIVE_PROVIDER_METHOD } from "@ezcorp/extension-runner/sensitive-host";
import { handleCredentialBroker, configureProviderCredentialTransport, injectCredentialHeaders, clearExpiredCredentialHandles } from "../credential-broker";
import { registerCallProvenance, releaseCallProvenance } from "../call-provenance";
import type { RpcHandlerDeps } from "../tool-executor/rpc-handlers";
import type { JsonRpcRequest } from "../types";

const children = new Set<ChildProcessWithoutNullStreams>();
const tokens: string[] = [];

function provider(program: string): FramedExecution {
  const child = spawn(process.execPath, ["-e", program], { stdio: ["pipe", "pipe", "pipe"] });
  children.add(child);
  child.once("close", () => children.delete(child));
  return new FramedExecution("provider", child, async () => null, async () => { child.kill("SIGKILL"); }, 64 * 1024, 250);
}

function fixture() {
  const token = registerCallProvenance({ actorExtensionId: "consumer", onBehalfOf: "user-a", conversationId: "conversation-a", runId: null, parentCallId: null, kind: "tool", ownerless: false });
  tokens.push(token);
  const permissions = { env: ["OPENAI_API_KEY"] };
  const deps = { registry: { getGrantedPermissions: () => permissions, getManifest: () => ({ permissions }) }, engine: { authorize: async () => ({ decision: "allow" }) } } as unknown as RpcHandlerDeps;
  const request = (method: string, params: Record<string, unknown> = {}): JsonRpcRequest => ({ jsonrpc: "2.0", id: "request", method, params: { ...params, _meta: { ezCallId: token } } });
  return { deps, request };
}

afterEach(() => {
  configureProviderCredentialTransport(null);
  clearExpiredCredentialHandles(Date.now() + 61_000);
  for (const token of tokens.splice(0)) releaseCallProvenance(token);
  for (const child of children) child.kill("SIGKILL");
  children.clear();
});

test("the credential broker alone consumes provider bytes and returns only an opaque handle", async () => {
  const firstSecret = "broker-only-provider-canary-1";
  const secondSecret = "broker-only-provider-canary-2";
  const execution = provider(`let count = 0; process.stdin.on("data", chunk => { for (const line of chunk.toString().trim().split("\\n")) { const request = JSON.parse(line); if (request.method !== ${JSON.stringify(SENSITIVE_PROVIDER_METHOD)} || request.sensitive !== true) process.exit(2); const secret = [${JSON.stringify(firstSecret)}, ${JSON.stringify(secondSecret)}][count++]; console.log(JSON.stringify({ jsonrpc: "2.0", id: request.id, sensitive: { kind: "provider-credential", encoding: "base64", data: Buffer.from(secret).toString("base64") } })); } });`);
  configureProviderCredentialTransport(execution, { providerId: "infisical", connectionId: "connection-a" });
  const { deps, request } = fixture();
  const issued = await handleCredentialBroker(deps, "consumer", request("ezcorp/env.get", { name: "OPENAI_API_KEY" }));
  expect(issued.result).toMatch(/^ezcred_v4_[a-f0-9]{64}$/);
  expect(JSON.stringify(issued)).not.toContain(firstSecret);
  expect(JSON.stringify(issued)).not.toContain(secondSecret);
  const headers = await injectCredentialHeaders(deps, "consumer", request("ezcorp/network.fetch"), new URL("https://api.openai.com/v1/responses"), new Headers({ authorization: `Bearer ${issued.result}` }));
  expect(headers.get("authorization")).toBe(`Bearer ${secondSecret}`);
  expect("requestSensitiveProviderResult" in ordinaryRunner).toBe(false);
  await expect(execution.request(SENSITIVE_PROVIDER_METHOD, {})).rejects.toThrow("credential broker");
  await execution.close();
});

test("provider failures become fixed broker errors without stdout or stderr canaries", async () => {
  const canary = "broker-failure-provider-canary";
  const execution = provider(`process.stdin.once("data", () => { process.stderr.write(${JSON.stringify(canary)}); process.stdout.write(${JSON.stringify(`${canary}\n`)}); });`);
  configureProviderCredentialTransport(execution, { providerId: "infisical", connectionId: "connection-a" });
  const { deps, request } = fixture();
  const response = await handleCredentialBroker(deps, "consumer", request("ezcorp/env.get", { name: "OPENAI_API_KEY" }));
  expect(response.error?.message).toBe("Credential access failed.");
  expect(JSON.stringify(response)).not.toContain(canary);
  await execution.close();
});

test("invalid provider identity fails before any sensitive request", async () => {
  const execution = provider("setInterval(() => {}, 1000)");
  expect(() => configureProviderCredentialTransport(execution, { providerId: "../bad", connectionId: "connection-a" })).toThrow("lookup failed");
  await execution.close();
});

test("broker transport rejects the dotted connection ID excluded by the provider config", async () => {
  const execution = provider("setInterval(() => {}, 1000)");
  try {
    expect(() => configureProviderCredentialTransport(execution, {
      providerId: "infisical",
      connectionId: "infisical.production",
    })).toThrow("lookup failed");
  } finally {
    await execution.close();
  }
});
