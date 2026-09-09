import { afterAll, beforeAll, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { buildIsolatedRelease } from "./helpers/first-party-release";
import { closeTestDb, getTestDb, mockDbConnection, setupTestDb } from "./helpers/test-pglite";
import { messages, toolCalls, users } from "../db/schema";
import { ToolExecutor } from "../extensions/tool-executor";
import { createPermissionEngine } from "../extensions/permission-engine";
import { registerCallProvenance, releaseCallProvenance } from "../extensions/call-provenance";
import { EventBus } from "../runtime/events";
import type { AgentEvents } from "../types";

mockDbConnection();
let release: Awaited<ReturnType<typeof buildIsolatedRelease>>;
let session: Awaited<ReturnType<typeof release.session>>;
let foreignId: string;
let toolCallId: string;
const manifest = { schemaVersion: 4, name: "finalize-proof", version: "1.0.0", description: "Finalize owner proof", author: { name: "Test" }, permissions: { appendMessages: { excludedDefault: true } }, tools: [{ name: "finish", description: "Finish owned call", inputSchema: { type: "object", properties: { toolCallId: { type: "string" } }, required: ["toolCallId"] } }] };

beforeAll(async () => {
  await setupTestDb();
  release = await buildIsolatedRelease({
    "manifest.ts": `export default ${JSON.stringify(manifest)};`,
    "manifest.test.ts": 'import {expect,test} from "bun:test"; import manifest from "./manifest"; test("declares append",()=>expect(manifest.permissions.appendMessages.excludedDefault).toBe(true));',
    "extension.ts": 'import {createRuntimeExtension,serve} from "@ezcorp/sdk/v4"; import {getChannel} from "@ezcorp/sdk/runtime"; import manifest from "./manifest"; const extension=await createRuntimeExtension({manifest,register:()=>{getChannel().onRequest("tools/call",async params=>{const input=(params as {arguments:{toolCallId:string}}).arguments;await getChannel().request("ezcorp/finalize-tool-call",{toolCallId:input.toolCallId,status:"complete",output:"verified owner"});return {content:[{type:"text",text:"done"}],isError:false};});}});await serve(extension);',
  }, "extension.ts");
  session = await release.session({ persistRelease: true });
  const bus = new EventBus<AgentEvents>();
  const engine = createPermissionEngine({ registry: session.registry, bus, db: getTestDb() });
  const executor = new ToolExecutor(session.registry, engine, { bus, eventDriven: true });
  await executor.ensureSubprocessRpcWired(session.id, session.process);
  const [foreign] = await getTestDb().insert(users).values({ email: "foreign-finalize@test.local", passwordHash: "unused", name: "Foreign", role: "admin", status: "active" }).returning();
  foreignId = foreign!.id;
  const [message] = await getTestDb().insert(messages).values({ conversationId: session.conversationId, role: "assistant", content: "Pending" }).returning();
  toolCallId = crypto.randomUUID();
  await getTestDb().insert(toolCalls).values({ id: toolCallId, conversationId: session.conversationId, messageId: message!.id, extensionId: session.id, toolName: "finish", input: {}, output: { content: [] }, success: false, durationMs: 0 });
}, 120_000);

afterAll(async () => { await session?.close(); await release?.close(); await closeTestDb(); });

test("real global worker cannot finalize another principal's row but its owner can", async () => {
  const invoke = async (principalId: string) => {
    const token = registerCallProvenance({ actorExtensionId: session.id, onBehalfOf: principalId, conversationId: null, runId: null, parentCallId: null, kind: "tool", ownerless: false });
    try { return await session.process.call("tools/call", { name: "finish", arguments: { toolCallId }, _meta: { ezCallId: token } }); }
    finally { releaseCallProvenance(token); }
  };
  await expect(invoke(foreignId)).rejects.toMatchObject({ code: "extension_error" });
  const [unchanged] = await getTestDb().select().from(toolCalls).where(eq(toolCalls.id, toolCallId));
  expect(unchanged?.output).toEqual({ content: [] });
  const own = await invoke(session.userId);
  expect((own.result as { isError: boolean }).isError).toBe(false);
  const [changed] = await getTestDb().select().from(toolCalls).where(eq(toolCalls.id, toolCallId));
  expect(changed?.output).toEqual({ content: [{ type: "text", text: "verified owner" }] });
  expect(session.starts()).toBe(2);
}, 90_000);
