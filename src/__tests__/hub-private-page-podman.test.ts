import { expect, mock, test, afterAll } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PodmanRunner, buildLimits, filesDigest } from "@ezcorp/extension-runner";
import { provisionToolchain } from "../../packages/@ezcorp/extension-runner/src/provision";
import { ReleaseProcess, releaseBinding } from "../extensions/release-process";
import { releaseRuntimeFixture } from "./helpers/release-runtime";
import { registerCallProvenance, releaseCallProvenance } from "../extensions/call-provenance";
import { ExtensionPageCache } from "../extensions/page-cache";
import type { ExtensionManifestV4 } from "@ezcorp/extension-contract";
import type { Extension } from "../db/schema";
import { restoreModuleMocks } from "./helpers/mock-cleanup";
import { createMockEvent, MEMBER_USER, mockServerAlias } from "./helpers/mock-request";
import { EventBus } from "../runtime/events";
import { ExtensionStateMediator } from "../extensions/state-mediator";
import type { AgentEvents } from "../types";
import type { RenderPullDeps } from "../../web/src/lib/server/hub-render-pull";

mockServerAlias();
const bus = new EventBus<AgentEvents>();
mock.module("$server/extensions/page-schema", () => require("../extensions/page-schema"));
mock.module("$server/extensions/page-cache", () => require("../extensions/page-cache"));
mock.module("$server/logger", () => require("../logger"));
mock.module("$lib/server/context", () => ({ getBus: () => bus, getExecutor: () => ({ runConversations: new Map() }) }));
mock.module("$lib/server/hub-extension-pages", () => ({ findEnabledExtensionPage: async () => null }));
const { renderExtensionPage } = await import("../../web/src/lib/server/hub-render-pull");
let httpDeps: Partial<RenderPullDeps>;
mock.module("$lib/server/hub-render-pull", () => ({ renderExtensionPage: (name: string, page: string, user: string) => renderExtensionPage(name, page, user, httpDeps) }));
mock.module("$lib/server/security/api-keys", () => require("../../web/src/lib/server/security/api-keys"));
mock.module("$lib/server/security/rate-limiter", () => require("../../web/src/lib/server/security/rate-limiter"));
mock.module("$lib/server/http-errors", () => require("../../web/src/lib/server/http-errors"));
mock.module("$lib/hub", () => require("../../web/src/lib/hub"));
mock.module("$server/runtime/hub-pages", () => require("../runtime/hub-pages"));
mock.module("$server/db/queries/conversations", () => require("../db/queries/conversations"));
mock.module("$server/runtime/sse-conversation-filter", () => require("../runtime/sse-conversation-filter"));
mock.module("$lib/runtime-event-names", () => require("../../web/src/lib/runtime-event-names"));
mock.module("$lib/server/sse-resume-buffer", () => require("../../web/src/lib/server/sse-resume-buffer"));
const { GET: pageGet } = await import("../../web/src/routes/api/hub/pages/[id]/+server");
const { GET: eventsGet } = await import("../../web/src/routes/api/runtime-events/+server");
afterAll(() => {
  mock.module("$lib/server/hub-extension-pages", () => require("../../web/src/lib/server/hub-extension-pages"));
  mock.module("$lib/server/hub-render-pull", () => require("../../web/src/lib/server/hub-render-pull"));
  mock.module("$lib/hub", () => require("../../web/src/lib/hub"));
  mock.module("$lib/runtime-event-names", () => require("../../web/src/lib/runtime-event-names"));
  mock.module("$lib/server/sse-resume-buffer", () => require("../../web/src/lib/server/sse-resume-buffer"));
  restoreModuleMocks();
});

test("rootless page rendering never shares a worker result or cache across authenticated principals", async () => {
  const root = await mkdtemp(join(tmpdir(), "ez-private-page-"));
  const runner = new PodmanRunner({ root, ...await provisionToolchain() });
  let process: ReleaseProcess | undefined;
  let server: ReturnType<typeof Bun.serve> | undefined;
  const streams = new AbortController();
  const manifest: ExtensionManifestV4 = { schemaVersion: 4, name: "private-page", version: "1.0.0", description: "Principal isolation fixture", author: { name: "Security tests" }, permissions: {}, panel: { position: "bottom" }, pages: [{ id: "dashboard", title: "Private" }], methods: [{ name: "ezcorp/page.render", inputSchema: { type: "object" }, outputSchema: { type: "object" } }] };
  const files = {
    "extension.ts": `import {defineExtension,serve,validateManifest} from '@ezcorp/sdk/v4'; import manifest from './manifest.json'; await serve(defineExtension({manifest:validateManifest(manifest),methods:{'ezcorp/page.render':{inputSchema:{type:'object'},outputSchema:{type:'object'},handle:async(_input,context)=>{const title='Private for '+context.invocation.principalId;await context.call('ezcorp/state',{state:{title}});return {title,nodes:[]};}}}}));`,
    "manifest.json": JSON.stringify(manifest),
    "contract.test.ts": "import {test,expect} from 'bun:test'; import manifest from './manifest.json'; test('private page declares its isolated render method',()=>expect(manifest.methods[0]?.name).toBe('ezcorp/page.render'));",
  };
  try {
    await runner.initialize();
    const build = await runner.build({ operationId: crypto.randomUUID(), files, sourceDigest: filesDigest(files), entrypoint: "extension.ts", limits: buildLimits });
    expect(build.diagnostics).toEqual([]);
    expect(build.state).toBe("succeeded");
    const extension = { id: crypto.randomUUID(), name: manifest.name, enabled: true, grantedPermissions: {} } as Extension;
    const fixture = releaseRuntimeFixture(extension.id, manifest, { artifactDigest: build.artifactDigest! });
    const runtime = { runner: async () => runner, resolve: async () => fixture.snapshot };
    process = new ReleaseProcess(extension.id, runtime);
    const mediator = new ExtensionStateMediator(bus, () => ({ name: manifest.name, panel: {} }));
    process.setNotificationHandler(notification => mediator.handleNotification(extension.id, notification));
    let renders = 0;
    const deps = {
      findPage: async () => ({ extension, page: manifest.pages![0]! }),
      authorize: async () => { if (!fixture.snapshot.installation.enabled) throw new Error("Revoked"); return releaseBinding(fixture.snapshot); },
      cache: new ExtensionPageCache(),
      timeoutMs: 30_000,
      callPage: async (_extension: Extension, pageId: string, userId: string) => {
        renders++;
        const token = registerCallProvenance({ onBehalfOf: userId, conversationId: null, runId: null, parentCallId: null, actorExtensionId: extension.id, kind: "render", ownerless: false });
        try { return await process!.call("ezcorp/page.render", { pageId, _meta: { ezCallId: token } }); }
        finally { releaseCallProvenance(token); }
      },
    };
    httpDeps = deps;
    const sessions = new Map<string, string>([[crypto.randomUUID(), "alice"], [crypto.randomUUID(), "bob"]]);
    const cookies = Object.fromEntries([...sessions].map(([token, user]) => [user, `session=${token}`]));
    server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
      const principal = sessions.get(request.headers.get("cookie")?.replace(/^session=/, "") ?? "");
      const event = createMockEvent({ url: request.url, params: { id: "ext:private-page:dashboard" }, ...(principal ? { user: { ...MEMBER_USER, id: principal }, authMethod: "session" } : {}) });
      event.request = request;
      const headers = new Headers();
      event.setHeaders = (values: Record<string, string>) => { for (const [name, value] of Object.entries(values)) headers.set(name, value); };
      try {
        const result = await (new URL(request.url).pathname === "/events" ? eventsGet(event) : pageGet(event));
        for (const [name, value] of headers) result.headers.set(name, value);
        return result;
      } catch (error) { if (error instanceof Response) return error; throw error; }
    } });
    const base = server.url.origin;
    const render = async (user: string) => {
      const response = await fetch(`${base}/page`, { headers: { cookie: cookies[user]!, "if-none-match": '"other-user"' } });
      expect(response.headers.get("cache-control")).toBe("private, no-store");
      expect(response.status).not.toBe(304);
      return response.json() as Promise<{ page?: { title: string }; error?: string }>;
    };
    expect((await fetch(`${base}/page`)).status).toBe(401);
    const streamSignal = AbortSignal.any([streams.signal, AbortSignal.timeout(30_000)]);
    const aliceStream = await fetch(`${base}/events`, { headers: { cookie: cookies.alice! }, signal: streamSignal });
    const bobStream = await fetch(`${base}/events`, { headers: { cookie: cookies.bob! }, signal: streamSignal });
    const [alice, bob] = await Promise.all([render("alice"), render("bob")]);
    expect(alice.page?.title).toBe("Private for alice");
    expect(bob.page?.title).toBe("Private for bob");
    async function readOwnState(response: Response, principal: string): Promise<string> {
      const reader = response.body!.getReader();
      let text = "";
      try {
        while (!text.includes(`Private for ${principal}`)) {
          const chunk = await reader.read();
          if (chunk.done) throw new Error("SSE closed before private state");
          text += new TextDecoder().decode(chunk.value);
        }
        return text;
      } finally { await reader.cancel(); }
    }
    const [aliceEvents, bobEvents] = await Promise.all([readOwnState(aliceStream, "alice"), readOwnState(bobStream, "bob")]);
    expect(aliceEvents).toContain('"type":"ext:state"');
    expect(aliceEvents).not.toContain("Private for bob");
    expect(bobEvents).toContain('"type":"ext:state"');
    expect(bobEvents).not.toContain("Private for alice");
    expect((await render("alice")).page?.title).toBe("Private for alice");
    expect((await render("bob")).page?.title).toBe("Private for bob");
    expect(renders).toBe(2);
    fixture.snapshot.installation.generation++;
    fixture.snapshot.installation.acknowledgedGeneration++;
    expect((await render("alice")).page?.title).toBe("Private for alice");
    expect(renders).toBe(3);
    fixture.snapshot.installation.enabled = false;
    const revoked = await fetch(`${base}/page`, { headers: { cookie: cookies.alice! } });
    expect(revoked.status).toBe(404);
    expect(renders).toBe(3);
  } finally {
    streams.abort();
    await server?.stop(true);
    process?.kill();
    await process?.whenCallsSettled();
    await runner.close();
    await rm(root, { recursive: true, force: true });
  }
}, 120_000);
