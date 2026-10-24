import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/svelte";
import "@testing-library/jest-dom/vitest";
import { EventBus } from "$server/runtime/events";
import { emitDetectionDecision } from "$server/runtime/preview/preview-detection-bridge";
import type { AgentEvents } from "$server/types";
import { parseConsentCardResult } from "$lib/components/tool-cards/preview-consent-card-logic";
import ToolCardRouter from "$lib/components/tool-cards/ToolCardRouter.svelte";
import { initStores, store } from "$lib/stores.svelte";
import { inlineToolStore, receivePreviewToolStart } from "$lib/inline-tool-store.svelte";

// The producer below is pure. Its unused DB decision collaborator is not
// loaded in a browser test; the provider/PGlite test exercises that decision.
vi.mock("$server/runtime/preview/preview-consent", () => ({ PREVIEW_CONSENT_CARD_TYPE: "ez-preview-consent" }));
const transport = vi.hoisted(() => ({ subscribers: new Set<(event: { type: string; data: unknown }) => void>() }));
vi.mock("$lib/ws", () => ({ createWSClient: () => ({
  subscribe(fn: (event: { type: string; data: unknown }) => void) { transport.subscribers.add(fn); return () => transport.subscribers.delete(fn); },
  close() {}, manualRetry() {},
}) }));
vi.mock("$lib/api", () => ({ fetchAgents: async () => [], fetchRuns: async () => [], fetchProjects: async () => [],
  fetchSettings: async () => ({}), fetchAgentConfigs: async () => [], fetchPipelines: async () => [], fetchWorkflows: async () => [] }));

let stop: (() => void) | undefined;
beforeEach(() => {
  transport.subscribers.clear(); inlineToolStore.calls = [];
  store.streamingRunToConversation = {}; store.streamingToolCalls = {};
  vi.stubGlobal("fetch", vi.fn(async () => new Response("{}")));
});
afterEach(() => { stop?.(); stop = undefined; cleanup(); vi.unstubAllGlobals(); });

function produce(auto = false) {
  const bus = new EventBus<AgentEvents>();
  const events: Array<{ type: string; data: unknown }> = [];
  for (const type of ["tool:start", "tool:complete"] as const) bus.on(type, data => events.push({ type, data }));
  emitDetectionDecision(bus, auto ? { kind: "auto-exposed", port: 5173, previewId: "host-preview", code: "host-code", subdomainLabel: "host-preview" } : { kind: "consent-card", port: 5173,
    card: { conversationId: "conversation-preview", port: 5173, title: "A site started on port 5173",
      summary: "Expose it to your browser? Nothing is served until you choose.",
      actions: { expose: "expose", ignore: "ignore", alwaysExpose: "always-expose" } } },
  { conversationId: "conversation-preview", userId: "owner-preview", port: 5173 }, { appHost: "preview.example.test", secure: true });
  return events;
}

test("the actual producer output is accepted by the real consent card parser", () => {
  const complete = produce().find(event => event.type === "tool:complete")!.data as AgentEvents["tool:complete"];
  expect(parseConsentCardResult(complete.output)).toMatchObject({ conversationId: "conversation-preview", port: 5173 });
});

test("actual emitted events render one consent card after the run ends and tolerate transport replay", () => {
  stop = initStores();
  const events = produce();
  for (const event of [...events, ...events]) for (const receive of transport.subscribers) receive(event);
  const entries = inlineToolStore.getByConversation("conversation-preview");
  expect(entries).toHaveLength(1);
  expect(entries[0]).toMatchObject({ source: "inline", status: "complete", cardType: "ez-preview-consent" });
  const { getAllByTestId, getByTestId } = render(ToolCardRouter, {
    toolCall: { ...entries[0]!, toolName: entries[0]!.toolName, status: "complete", startedAt: entries[0]!.startedAt ?? 0 }, conversationId: "conversation-preview",
  });
  expect(getAllByTestId("preview-consent-card")).toHaveLength(1);
  expect(getByTestId("preview-consent-expose")).toBeVisible();
});

test("actual consent output posts only its conversation and port when the owner chooses Expose", async () => {
  const fetch = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(JSON.stringify({ openUrl: "https://host-preview.preview.example.test/__open?c=host-code" })));
  vi.stubGlobal("fetch", fetch);
  const complete = produce().at(-1)!.data as AgentEvents["tool:complete"];
  const { getByTestId } = render(ToolCardRouter, { toolCall: { id: complete.invocationId!, toolName: "preview_detected", input: {}, status: "complete",
    output: JSON.stringify(complete.output), startedAt: 0, cardType: complete.cardType }, conversationId: "conversation-preview" });
  await fireEvent.click(getByTestId("preview-consent-expose"));
  await waitFor(() => expect(getByTestId("preview-consent-open")).toHaveAttribute("href", "https://host-preview.preview.example.test/__open?c=host-code"));
  expect(JSON.parse(fetch.mock.calls[0]![1]!.body as string)).toEqual({ action: "expose", conversationId: "conversation-preview", port: 5173 });
});

test("actual auto-exposed output renders the host-generated link without another consent request", () => {
  const complete = produce(true).at(-1)!.data as AgentEvents["tool:complete"];
  const { getByTestId, queryByTestId } = render(ToolCardRouter, { toolCall: { id: complete.invocationId!, toolName: "preview_detected", input: {}, status: "complete",
    output: JSON.stringify(complete.output), startedAt: 0, cardType: complete.cardType }, conversationId: "conversation-preview" });
  expect(getByTestId("preview-consent-open")).toHaveAttribute("href", "https://host-preview.preview.preview.example.test/__open?c=host-code");
  expect(queryByTestId("preview-consent-expose")).toBeNull();
  expect(globalThis.fetch).not.toHaveBeenCalled();
  for (const openUrl of ["javascript:alert(1)", "not a URL", null]) {
    expect(parseConsentCardResult({ ...complete.output as object, openUrl })).toBeNull();
  }
});

test("only exact preview starts seed the store and teardown removes both subscribers", () => {
  const start = produce()[0]!;
  for (const data of [null, [], { ...start.data as object, toolName: "shell" }, { ...start.data as object, source: "agent-run" },
    { ...start.data as object, extensionId: "other" }, { ...start.data as object, cardType: "other" },
    { ...start.data as object, invocationId: "invalid" }, { ...start.data as object, conversationId: "" },
    { ...start.data as object, input: null }, { ...start.data as object, input: { port: 80 } }, { ...start.data as object, input: { port: 65536 } }]) {
    receivePreviewToolStart({ type: "tool:start", data });
  }
  receivePreviewToolStart({ ...start, type: "tool:complete" });
  expect(inlineToolStore.calls).toHaveLength(0);
  stop = initStores();
  expect(transport.subscribers.size).toBe(2);
  for (const event of produce()) for (const receive of transport.subscribers) receive(event);
  expect(inlineToolStore.getByConversation("wrong-conversation")).toHaveLength(0);
  stop(); stop = undefined;
  expect(transport.subscribers.size).toBe(0);
});

test("both subscribers reject a preview completion with another conversation or port and preserve unrelated invocations", () => {
  stop = initStores();
  const events = produce();
  for (const event of events) for (const receive of transport.subscribers) receive(event);
  const complete = events[1]!.data as AgentEvents["tool:complete"];
  const original = JSON.parse(JSON.stringify(inlineToolStore.getByConversation("conversation-preview")[0]));
  for (const output of [{ ...complete.output as object, conversationId: "wrong-conversation" }, { ...complete.output as object, port: 9999 }, {}]) {
    for (const receive of transport.subscribers) receive({ type: "tool:complete", data: { ...complete, output } });
    expect(inlineToolStore.getByConversation("conversation-preview")[0]).toEqual(original);
  }
  inlineToolStore.calls = [];
  inlineToolStore.add({ id: complete.invocationId!, conversationId: "unrelated-conversation", extensionName: "other", toolName: "other", input: {} });
  const unrelated = JSON.parse(JSON.stringify(inlineToolStore.calls[0]));
  for (const event of events) for (const receive of transport.subscribers) receive(event);
  expect(inlineToolStore.calls).toEqual([unrelated]);
});

test("consent parsing retains malformed and envelope refusals on the canonical web runner", () => {
  for (const value of [null, "", "not json", "[]", { port: 5173 }, { conversationId: "c", port: 0 }, 123]) expect(parseConsentCardResult(value)).toBeNull();
  expect(parseConsentCardResult({ content: [{ text: '{"conversationId":"c","port":5173}' }, { text: null }] })).toMatchObject({ conversationId: "c", port: 5173 });
});
