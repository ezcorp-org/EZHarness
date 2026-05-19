import { test, expect, describe, beforeEach } from "bun:test";
import { detectCycle } from "../runtime/dag-validator";
import { composeAgent } from "../runtime/config-to-agent";
import { agentColor } from "../../web/src/lib/agent-color";
import type { AgentCapability } from "../types";

function need<T>(v: T | undefined, what: string): T {
  if (v === undefined) throw new Error(`expected ${what}`);
  return v;
}

// ── Test Agents ──────────────────────────────────────────────────────

const AGENTS = {
  researcher: { id: "agent-researcher", name: "researcher", description: "Research agent", capabilities: ["llm"] as AgentCapability[], prompt: "You are a researcher" },
  coder: { id: "agent-coder", name: "coder", description: "Coding agent", capabilities: ["llm", "custom"] as AgentCapability[], prompt: "You are a coder" },
  reviewer: { id: "agent-reviewer", name: "reviewer", description: "Review agent", capabilities: ["llm"] as AgentCapability[], prompt: "You are a reviewer" },
  debugger: { id: "agent-debugger", name: "debugger", description: "Debug agent", capabilities: ["llm", "custom"] as AgentCapability[], prompt: "You are a debugger" },
};

// ── Re-implement store without Svelte 5 runes for testability ────────

interface SubConversationState {
  id: string;
  agentConfigId: string;
  agentName: string;
  parentConversationId: string;
  parentMessageId: string;
}

interface SubConvoMessage {
  id: string;
  role: string;
  content: string;
  createdAt: Date;
}

class TestSubConversationStore {
  activeSubConversation: SubConversationState | null = null;
  subConvoMessages: SubConvoMessage[] = [];
  isStreaming = false;

  get isInSubConversation(): boolean { return this.activeSubConversation !== null; }
  get activeSubConversationId(): string | null { return this.activeSubConversation?.id ?? null; }

  startSubConversation(opts: SubConversationState): void {
    this.activeSubConversation = opts;
    this.subConvoMessages = [];
    this.isStreaming = false;
  }

  endSubConversation(): SubConvoMessage[] {
    const messages = this.subConvoMessages;
    this.activeSubConversation = null;
    this.subConvoMessages = [];
    this.isStreaming = false;
    return messages;
  }

  addMessage(msg: SubConvoMessage): void {
    this.subConvoMessages = [...this.subConvoMessages, msg];
  }

  setStreaming(streaming: boolean): void { this.isStreaming = streaming; }
}

// ── Helpers ──────────────────────────────────────────────────────────

function makeSubConvoState(agent: typeof AGENTS.researcher, parentConvId = "conv-1", parentMsgId = "msg-1"): SubConversationState {
  return {
    id: `sub-${agent.id}`,
    agentConfigId: agent.id,
    agentName: agent.name,
    parentConversationId: parentConvId,
    parentMessageId: parentMsgId,
  };
}

function makeMessage(id: string, role: string, content: string): SubConvoMessage {
  return { id, role, content, createdAt: new Date() };
}

function getSummary(messages: SubConvoMessage[]): SubConvoMessage | undefined {
  return [...messages].reverse().find(m => m.role === "assistant");
}

// ── Tests ────────────────────────────────────────────────────────────

describe("Sub-Conversation E2E Flows", () => {
  let store: TestSubConversationStore;

  beforeEach(() => {
    store = new TestSubConversationStore();
  });

  // 1. Single agent sub-conversation flow
  describe("single agent sub-conversation flow", () => {
    test("full lifecycle: mention → start → messages → end → clean", () => {
      // Simulate @researcher mention detected
      const agent = AGENTS.researcher;

      // DAG validation: researcher has no refs, no cycle possible
      const allRefs = new Map<string, string[]>();
      expect(detectCycle(agent.id, [], allRefs)).toBeNull();

      // Start sub-conversation
      store.startSubConversation(makeSubConvoState(agent));
      expect(store.isInSubConversation).toBe(true);
      expect(store.activeSubConversationId).toBe(`sub-${agent.id}`);

      // Add user message and assistant response
      store.addMessage(makeMessage("m1", "user", "Find info about X"));
      store.addMessage(makeMessage("m2", "assistant", "Here is the research summary on X."));

      expect(store.subConvoMessages.length).toBe(2);

      // End sub-conversation
      const messages = store.endSubConversation();
      const summary = getSummary(messages);

      expect(summary).toBeDefined();
      expect(summary!.content).toContain("research summary");
      expect(messages.length).toBe(2);

      // Store is clean
      expect(store.isInSubConversation).toBe(false);
      expect(store.activeSubConversationId).toBeNull();
      expect(store.subConvoMessages.length).toBe(0);
      expect(store.isStreaming).toBe(false);
    });
  });

  // 2. Sequential multi-agent sub-conversations
  describe("sequential multi-agent sub-conversations", () => {
    test("three agents in sequence with no message leakage", () => {
      // Researcher: 3 messages
      store.startSubConversation(makeSubConvoState(AGENTS.researcher));
      store.addMessage(makeMessage("r1", "user", "research request"));
      store.addMessage(makeMessage("r2", "assistant", "research finding 1"));
      store.addMessage(makeMessage("r3", "assistant", "research summary"));
      const researchMsgs = store.endSubConversation();
      const researchSummary = getSummary(researchMsgs);
      expect(researchMsgs.length).toBe(3);
      expect(researchSummary!.content).toBe("research summary");

      // Coder: 2 messages
      store.startSubConversation(makeSubConvoState(AGENTS.coder));
      expect(store.subConvoMessages.length).toBe(0); // no leakage
      store.addMessage(makeMessage("c1", "user", "code request"));
      store.addMessage(makeMessage("c2", "assistant", "code output"));
      const codeMsgs = store.endSubConversation();
      const codeSummary = getSummary(codeMsgs);
      expect(codeMsgs.length).toBe(2);
      expect(codeSummary!.content).toBe("code output");

      // Reviewer: 1 message
      store.startSubConversation(makeSubConvoState(AGENTS.reviewer));
      expect(store.subConvoMessages.length).toBe(0); // no leakage
      store.addMessage(makeMessage("v1", "assistant", "review complete"));
      const reviewMsgs = store.endSubConversation();
      const reviewSummary = getSummary(reviewMsgs);
      expect(reviewMsgs.length).toBe(1);
      expect(reviewSummary!.content).toBe("review complete");

      // Each summary is independent
      expect(researchSummary!.id).not.toBe(codeSummary!.id);
      expect(codeSummary!.id).not.toBe(reviewSummary!.id);

      // Store clean
      expect(store.isInSubConversation).toBe(false);
      expect(store.subConvoMessages.length).toBe(0);
    });
  });

  // 3. Agent composition with DAG validation
  describe("agent composition with DAG validation", () => {
    test("validates DAG and detects cycles in agent reference graph", () => {
      const allRefs = new Map<string, string[]>();

      // researcher has no refs
      allRefs.set(AGENTS.researcher.id, []);
      expect(detectCycle(AGENTS.researcher.id, [], allRefs)).toBeNull();

      // coder refs [researcher]
      allRefs.set(AGENTS.coder.id, [AGENTS.researcher.id]);
      expect(detectCycle(AGENTS.coder.id, [AGENTS.researcher.id], allRefs)).toBeNull();

      // reviewer refs [coder]
      allRefs.set(AGENTS.reviewer.id, [AGENTS.coder.id]);
      expect(detectCycle(AGENTS.reviewer.id, [AGENTS.coder.id], allRefs)).toBeNull();

      // debugger refs [researcher, reviewer] — still no cycle
      expect(detectCycle(AGENTS.debugger.id, [AGENTS.researcher.id, AGENTS.reviewer.id], allRefs)).toBeNull();

      // Now add debugger with those refs
      allRefs.set(AGENTS.debugger.id, [AGENTS.researcher.id, AGENTS.reviewer.id]);

      // Try to make researcher ref debugger — cycle detected
      // Shortest cycle: researcher→debugger→researcher (debugger refs researcher directly)
      const cycle = detectCycle(AGENTS.researcher.id, [AGENTS.debugger.id], allRefs);
      expect(cycle).not.toBeNull();
      expect(cycle!.length).toBeGreaterThanOrEqual(3); // at least [A, B, A]

      // Verify cycle path contains the direct cycle participants
      expect(cycle).toContain(AGENTS.researcher.id);
      expect(cycle).toContain(AGENTS.debugger.id);

      // Cycle starts and ends with same node
      expect(cycle![0]).toBe(cycle![cycle!.length - 1]);
    });
  });

  // 4. Composition depth with multi-agent pipeline
  describe("composition depth with multi-agent pipeline", () => {
    test("respects max depth and fails with descriptive error", () => {
      // depth=0 succeeds
      const r0 = composeAgent(AGENTS.researcher, { depth: 0, maxDepth: 3, timeout: 5000 });
      expect(r0.agent).toBeDefined();
      expect(r0.error).toBeUndefined();

      // depth=1 succeeds
      const r1 = composeAgent(AGENTS.coder, { depth: 1, maxDepth: 3, timeout: 5000 });
      expect(r1.agent).toBeDefined();
      expect(r1.error).toBeUndefined();

      // depth=2 succeeds
      const r2 = composeAgent(AGENTS.reviewer, { depth: 2, maxDepth: 3, timeout: 5000 });
      expect(r2.agent).toBeDefined();
      expect(r2.error).toBeUndefined();

      // depth=3, maxDepth=3 — fails
      const r3 = composeAgent(AGENTS.debugger, { depth: 3, maxDepth: 3, timeout: 5000 });
      expect(r3.agent).toBeUndefined();
      expect(r3.error).toBeDefined();
      expect(r3.error).toContain("debugger");
      expect(r3.error).toContain("Max composition depth");
    });
  });

  // 5. Store + color consistency across agent lifecycle
  describe("store + color consistency across agent lifecycle", () => {
    test("each agent gets consistent color and store is clean after all cycles", () => {
      const agentList = [AGENTS.researcher, AGENTS.coder, AGENTS.reviewer, AGENTS.debugger];
      const colors: Record<string, string> = {};

      for (const agent of agentList) {
        // Get color before
        const colorBefore = agentColor(agent.name);
        colors[agent.name] = colorBefore;

        // Start sub-convo, add messages, end
        store.startSubConversation(makeSubConvoState(agent));
        store.addMessage(makeMessage(`${agent.name}-m1`, "user", `ask ${agent.name}`));
        store.addMessage(makeMessage(`${agent.name}-m2`, "assistant", `reply from ${agent.name}`));
        store.endSubConversation();

        // Get color after — must be same
        const colorAfter = agentColor(agent.name);
        expect(colorAfter).toBe(colorBefore);
      }

      // All 4 agents have colors
      expect(Object.keys(colors).length).toBe(4);

      // Colors are deterministic: calling again yields same result
      for (const agent of agentList) {
        expect(agentColor(agent.name)).toBe(need(colors[agent.name], `color for ${agent.name}`));
      }

      // Store is fully clean
      expect(store.isInSubConversation).toBe(false);
      expect(store.activeSubConversationId).toBeNull();
      expect(store.subConvoMessages.length).toBe(0);
      expect(store.isStreaming).toBe(false);
    });
  });

  // 6. Concurrent prevention
  describe("concurrent prevention", () => {
    test("starting new sub-convo overwrites previous one", () => {
      // Start with researcher
      store.startSubConversation(makeSubConvoState(AGENTS.researcher));
      store.addMessage(makeMessage("r1", "user", "research stuff"));
      expect(store.activeSubConversation!.agentName).toBe("researcher");
      expect(store.subConvoMessages.length).toBe(1);

      // Start with coder — should overwrite
      store.startSubConversation(makeSubConvoState(AGENTS.coder));
      expect(store.activeSubConversation!.agentName).toBe("coder");
      // researcher state is gone — messages were cleared on start
      expect(store.subConvoMessages.length).toBe(0);
      expect(store.activeSubConversationId).toBe(`sub-${AGENTS.coder.id}`);

      // Only coder sub-convo is active
      expect(store.isInSubConversation).toBe(true);
      expect(store.activeSubConversation!.agentConfigId).toBe(AGENTS.coder.id);

      // End coder, verify clean
      const msgs = store.endSubConversation();
      expect(msgs.length).toBe(0);
      expect(store.isInSubConversation).toBe(false);
      expect(store.activeSubConversationId).toBeNull();
      expect(store.subConvoMessages.length).toBe(0);
    });
  });
});
