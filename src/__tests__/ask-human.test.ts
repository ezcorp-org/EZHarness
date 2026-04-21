import { test, expect, describe, beforeEach } from "bun:test";
import { createAskHumanTool, resolveHumanInput, rejectHumanInput, hasPendingHumanInput } from "../runtime/tools/ask-human";
import { EventBus } from "../runtime/events";
import type { AgentEvents } from "../types";

describe("ask-human tool", () => {
  let bus: EventBus<AgentEvents>;

  beforeEach(() => {
    bus = new EventBus<AgentEvents>();
  });

  test("createAskHumanTool returns tool named ask_human", () => {
    const tool = createAskHumanTool({ bus, runId: "r1", conversationId: "c1" });
    expect(tool.name).toBe("ask_human");
  });

  test("execute emits orchestrator:human_input event with correct data", async () => {
    const tool = createAskHumanTool({ bus, runId: "r1", conversationId: "c1" });

    let capturedData: any;
    bus.on("orchestrator:human_input", (data) => {
      capturedData = data;
    });

    const resultPromise = tool.execute("call-1", { question: "What color?" });
    await new Promise((r) => setTimeout(r, 10));

    expect(capturedData).toBeDefined();
    expect(capturedData.runId).toBe("r1");
    expect(capturedData.conversationId).toBe("c1");
    expect(capturedData.question).toBe("What color?");
    expect(typeof capturedData.requestId).toBe("string");

    // Clean up by resolving
    resolveHumanInput(capturedData.requestId, "done");
    await resultPromise;
  });

  test("execute blocks until resolveHumanInput is called, then returns user response", async () => {
    const tool = createAskHumanTool({ bus, runId: "r1", conversationId: "c1" });

    let capturedRequestId: string | undefined;
    bus.on("orchestrator:human_input", (data) => {
      capturedRequestId = (data as any).requestId;
    });

    const resultPromise = tool.execute("call-1", { question: "What color?" });
    await new Promise((r) => setTimeout(r, 10));

    resolveHumanInput(capturedRequestId!, "blue");

    const result = await resultPromise;
    expect((result.content[0] as any).text).toBe("blue");
  });

  test("rejectHumanInput causes execute to return error result", async () => {
    const tool = createAskHumanTool({ bus, runId: "r1", conversationId: "c1" });

    let capturedRequestId: string | undefined;
    bus.on("orchestrator:human_input", (data) => {
      capturedRequestId = (data as any).requestId;
    });

    const resultPromise = tool.execute("call-1", { question: "Confirm?" });
    await new Promise((r) => setTimeout(r, 10));

    rejectHumanInput(capturedRequestId!);

    const result = await resultPromise;
    expect((result.content[0] as any).text).toContain("Error:");
    expect((result.content[0] as any).text).toContain("dismissed");
  });

  test("hasPendingHumanInput returns true while waiting, false after resolution", async () => {
    const tool = createAskHumanTool({ bus, runId: "r1", conversationId: "c1" });

    let capturedRequestId: string | undefined;
    bus.on("orchestrator:human_input", (data) => {
      capturedRequestId = (data as any).requestId;
    });

    const resultPromise = tool.execute("call-1", { question: "Ready?" });
    await new Promise((r) => setTimeout(r, 10));

    expect(hasPendingHumanInput(capturedRequestId!)).toBe(true);

    resolveHumanInput(capturedRequestId!, "yes");
    await resultPromise;

    expect(hasPendingHumanInput(capturedRequestId!)).toBe(false);
  });

  test("abort signal cancels the wait and returns error", async () => {
    const tool = createAskHumanTool({ bus, runId: "r1", conversationId: "c1" });
    const controller = new AbortController();

    let capturedRequestId: string | undefined;
    bus.on("orchestrator:human_input", (data) => {
      capturedRequestId = (data as any).requestId;
    });

    const resultPromise = tool.execute("call-1", { question: "Hello?" }, controller.signal);
    await new Promise((r) => setTimeout(r, 10));

    controller.abort();
    const result = await resultPromise;

    expect((result.content[0] as any).text).toContain("Error:");
    expect((result.content[0] as any).text).toContain("Aborted");
    expect(hasPendingHumanInput(capturedRequestId!)).toBe(false);
  });

  test("resolveHumanInput with unknown requestId is a no-op", () => {
    // Should not throw
    resolveHumanInput("nonexistent-id", "response");
    expect(hasPendingHumanInput("nonexistent-id")).toBe(false);
  });

  test("rejectHumanInput with unknown requestId is a no-op", () => {
    // Should not throw
    rejectHumanInput("nonexistent-id");
    expect(hasPendingHumanInput("nonexistent-id")).toBe(false);
  });

  test("requestId is unique per call", async () => {
    const tool = createAskHumanTool({ bus, runId: "r1", conversationId: "c1" });
    const requestIds: string[] = [];

    bus.on("orchestrator:human_input", (data) => {
      requestIds.push((data as any).requestId);
    });

    const p1 = tool.execute("call-1", { question: "Q1?" });
    await new Promise((r) => setTimeout(r, 10));
    resolveHumanInput(requestIds[0]!, "a1");
    await p1;

    const p2 = tool.execute("call-2", { question: "Q2?" });
    await new Promise((r) => setTimeout(r, 10));
    resolveHumanInput(requestIds[1]!, "a2");
    await p2;

    expect(requestIds).toHaveLength(2);
    expect(requestIds[0]).not.toBe(requestIds[1]);
  });
});
