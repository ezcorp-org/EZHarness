import { describe, test, expect } from "vitest";
import {
	type Topic,
	type SavedContext,
	type ContextType,
	MAX_PILLS_PER_MESSAGE,
	DEFAULT_EXTRACT_ERROR,
	DEFAULT_EXTRACT_FAULT,
	extractErrorCopy,
	refreshLabel,
	countNewMessages,
	topicsByMessageId,
	contextTypeMap,
	typeBadgeLabel,
	typeBadgeClass,
	parseModelSetting,
	capabilityNotice,
	laneLabel,
	MODEL_SUPPORT_REASON_LABELS,
	EXTRACT_IDLE,
	extractStarting,
	extractResolved,
	extractErrored,
	markCopied,
	isExtracting,
	extractResult,
	isCopied,
	needsManualCopy,
	extractError,
} from "$lib/topic-contexts-logic";
import type { TopicCapability } from "$lib/topic-contexts-logic";

function topic(id: string, messageIds: string[], typeId = "feature"): Topic {
	return { id, label: `Topic ${id}`, typeId, messageIds };
}

const sampleContext: SavedContext = {
	id: "ctx-1",
	topicLabel: "Auth flow",
	typeId: "feature",
	title: "Auth flow",
	content: "# Auth\nJWT with refresh rotation.",
	model: "ollama/qwen3:1.7b",
	updatedAt: "2026-07-13T00:00:00.000Z",
};

describe("refreshLabel", () => {
	test("never analyzed → Analyze", () => {
		expect(refreshLabel({ analyzedAt: null, stale: false })).toEqual({
			text: "Analyze",
			kind: "analyze",
		});
	});

	test("analyzed + fresh → Re-analyze", () => {
		expect(
			refreshLabel({ analyzedAt: "2026-07-13T00:00:00Z", stale: false }),
		).toEqual({ text: "Re-analyze", kind: "fresh" });
	});

	test("analyzed + stale with N new → Refresh (N new)", () => {
		expect(
			refreshLabel({
				analyzedAt: "2026-07-13T00:00:00Z",
				stale: true,
				newCount: 3,
			}),
		).toEqual({ text: "Refresh (3 new)", kind: "stale" });
	});

	test("analyzed + stale with unknown/zero N → Refresh", () => {
		expect(
			refreshLabel({ analyzedAt: "2026-07-13T00:00:00Z", stale: true }),
		).toEqual({ text: "Refresh", kind: "stale" });
		expect(
			refreshLabel({
				analyzedAt: "2026-07-13T00:00:00Z",
				stale: true,
				newCount: 0,
			}),
		).toEqual({ text: "Refresh", kind: "stale" });
	});
});

describe("countNewMessages", () => {
	test("counts live messages not covered by any topic", () => {
		const topics = [topic("t1", ["m1", "m2"]), topic("t2", ["m2", "m3"])];
		expect(countNewMessages(["m1", "m2", "m3", "m4", "m5"], topics)).toBe(2);
	});

	test("all covered → 0", () => {
		expect(countNewMessages(["m1", "m2"], [topic("t1", ["m1", "m2"])])).toBe(0);
	});

	test("no topics → every message is new", () => {
		expect(countNewMessages(["m1", "m2"], [])).toBe(2);
	});
});

describe("topicsByMessageId", () => {
	test("groups topics under each anchored message, preserving order", () => {
		const t1 = topic("t1", ["m1", "m2"]);
		const t2 = topic("t2", ["m2"]);
		const map = topicsByMessageId([t1, t2]);
		expect(map.get("m1")).toEqual([t1]);
		expect(map.get("m2")).toEqual([t1, t2]);
		expect(map.has("m3")).toBe(false);
	});

	test("caps pills per message (overflow dropped)", () => {
		const anchored = ["t1", "t2", "t3", "t4", "t5"].map((id) =>
			topic(id, ["m1"]),
		);
		const map = topicsByMessageId(anchored, 2);
		expect(map.get("m1")).toHaveLength(2);
		expect(map.get("m1")!.map((t) => t.id)).toEqual(["t1", "t2"]);
	});

	test("default cap is MAX_PILLS_PER_MESSAGE", () => {
		const anchored = Array.from({ length: MAX_PILLS_PER_MESSAGE + 2 }, (_, i) =>
			topic(`t${i}`, ["m1"]),
		);
		expect(topicsByMessageId(anchored).get("m1")).toHaveLength(
			MAX_PILLS_PER_MESSAGE,
		);
	});
});

describe("context type helpers", () => {
	const types: ContextType[] = [
		{ id: "feature", label: "Feature", description: "A feature", sortOrder: 0 },
		{ id: "idea", label: "Idea", description: "An idea", sortOrder: 1 },
	];

	test("contextTypeMap keys rows by id", () => {
		const map = contextTypeMap(types);
		expect(map.get("feature")?.label).toBe("Feature");
		expect(map.size).toBe(2);
	});

	test("typeBadgeLabel resolves known + falls back to the raw id", () => {
		const map = contextTypeMap(types);
		expect(typeBadgeLabel("feature", map)).toBe("Feature");
		expect(typeBadgeLabel("mystery", map)).toBe("mystery");
	});

	test("typeBadgeClass returns a class for known slugs + a fallback", () => {
		expect(typeBadgeClass("feature")).toContain("blue");
		expect(typeBadgeClass("bug-fix")).toContain("red");
		expect(typeBadgeClass("nonexistent")).toContain("--color-surface-tertiary");
	});
});

describe("parseModelSetting", () => {
	test("valid provider/model", () => {
		expect(parseModelSetting("openai/gpt-4o")).toEqual({
			provider: "openai",
			modelId: "gpt-4o",
		});
	});

	test("model id may contain slashes (split on first)", () => {
		expect(parseModelSetting("openrouter/anthropic/claude-3.5")).toEqual({
			provider: "openrouter",
			modelId: "anthropic/claude-3.5",
		});
	});

	test("no slash → null", () => {
		expect(parseModelSetting("gpt-4o")).toBeNull();
	});

	test("empty / null / undefined → null", () => {
		expect(parseModelSetting("")).toBeNull();
		expect(parseModelSetting(null)).toBeNull();
		expect(parseModelSetting(undefined)).toBeNull();
	});

	test("leading or trailing slash → null", () => {
		expect(parseModelSetting("/gpt-4o")).toBeNull();
		expect(parseModelSetting("openai/")).toBeNull();
	});
});

describe("extractErrorCopy", () => {
	test("prefers a non-empty server {error} message (any status)", () => {
		expect(extractErrorCopy(503, { error: "No model available" })).toBe(
			"No model available",
		);
		expect(extractErrorCopy(500, { error: "topic extraction returned no content" })).toBe(
			"topic extraction returned no content",
		);
	});

	test("503 with no usable error body → the no-model default", () => {
		expect(extractErrorCopy(503, {})).toBe(DEFAULT_EXTRACT_ERROR);
		expect(extractErrorCopy(503, { error: "   " })).toBe(DEFAULT_EXTRACT_ERROR);
		expect(extractErrorCopy(503, null)).toBe(DEFAULT_EXTRACT_ERROR);
	});

	test("non-503 fault with no error body → the generic-fault copy, NOT no-model", () => {
		expect(extractErrorCopy(500, {})).toBe(DEFAULT_EXTRACT_FAULT);
		expect(extractErrorCopy(500, { error: 42 })).toBe(DEFAULT_EXTRACT_FAULT);
		expect(extractErrorCopy(500, undefined)).toBe(DEFAULT_EXTRACT_FAULT);
	});
});

describe("extract state machine", () => {
	test("idle constant", () => {
		expect(EXTRACT_IDLE).toEqual({ status: "idle" });
		expect(isExtracting(EXTRACT_IDLE)).toBe(false);
		expect(extractResult(EXTRACT_IDLE)).toBeNull();
		expect(isCopied(EXTRACT_IDLE)).toBe(false);
		expect(needsManualCopy(EXTRACT_IDLE)).toBe(false);
		expect(extractError(EXTRACT_IDLE)).toBeNull();
	});

	test("extracting", () => {
		const s = extractStarting();
		expect(s).toEqual({ status: "extracting" });
		expect(isExtracting(s)).toBe(true);
		expect(extractResult(s)).toBeNull();
	});

	test("resolved + copied", () => {
		const s = extractResolved(sampleContext, true);
		expect(s.status).toBe("copied");
		expect(extractResult(s)).toBe(sampleContext);
		expect(isCopied(s)).toBe(true);
		expect(needsManualCopy(s)).toBe(false);
	});

	test("resolved + copy failed", () => {
		const s = extractResolved(sampleContext, false);
		expect(s.status).toBe("copyFailed");
		expect(extractResult(s)).toBe(sampleContext);
		expect(isCopied(s)).toBe(false);
		expect(needsManualCopy(s)).toBe(true);
	});

	test("errored uses the given message", () => {
		const s = extractErrored("Model unavailable");
		expect(s).toEqual({ status: "error", message: "Model unavailable" });
		expect(extractError(s)).toBe("Model unavailable");
	});

	test("errored falls back on an empty message", () => {
		expect(extractErrored("")).toEqual({
			status: "error",
			message: DEFAULT_EXTRACT_ERROR,
		});
	});

	test("markCopied flips copyFailed → copied", () => {
		const failed = extractResolved(sampleContext, false);
		const copied = markCopied(failed);
		expect(copied.status).toBe("copied");
		expect(extractResult(copied)).toBe(sampleContext);
	});

	test("markCopied is a no-op for non-copyFailed states", () => {
		expect(markCopied(EXTRACT_IDLE)).toBe(EXTRACT_IDLE);
		const copied = extractResolved(sampleContext, true);
		expect(markCopied(copied)).toBe(copied);
	});
});

describe("capabilityNotice", () => {
	const cap = (o: Partial<TopicCapability>): TopicCapability => ({
		localModel: "qwen3.5:4b",
		supported: true,
		activeLane: "local",
		...o,
	});

	test("absent / undefined capability → none", () => {
		expect(capabilityNotice(null)).toEqual({ kind: "none" });
		expect(capabilityNotice(undefined)).toEqual({ kind: "none" });
	});

	test("supported → none (no notice)", () => {
		expect(capabilityNotice(cap({ supported: true }))).toEqual({ kind: "none" });
	});

	test("unsupported + activeLane local (no fallback) → prominent, names model + reason", () => {
		const n = capabilityNotice(cap({ supported: false, reason: "load-failed", activeLane: "local" }));
		expect(n.kind).toBe("prominent");
		expect(n.kind === "prominent" && n.text).toContain("qwen3.5:4b");
		expect(n.kind === "prominent" && n.text).toContain("couldn't load it");
		expect(n.kind === "prominent" && n.text).toContain("Settings → Topic contexts");
	});

	test("unsupported + missing reason → prominent with generic 'unavailable'", () => {
		const n = capabilityNotice(cap({ supported: false, activeLane: "local" }));
		expect(n.kind === "prominent" && n.text).toContain("it is unavailable");
	});

	test("unsupported + turn-model fallback → subtle 'using the chat model'", () => {
		const n = capabilityNotice(cap({ supported: false, reason: "timeout", activeLane: "turn-model" }));
		expect(n).toEqual({ kind: "subtle", text: "Local model unavailable — using the chat model." });
	});

	test("unsupported + cloud fallback → subtle 'using the selected model'", () => {
		const n = capabilityNotice(cap({ supported: false, reason: "endpoint-down", activeLane: "cloud" }));
		expect(n).toEqual({ kind: "subtle", text: "Local model unavailable — using the selected model." });
	});
});

describe("laneLabel + reason labels", () => {
	test("laneLabel maps cloud vs turn-model", () => {
		expect(laneLabel("cloud")).toBe("the selected model");
		expect(laneLabel("turn-model")).toBe("the chat model");
		expect(laneLabel("local")).toBe("the chat model");
	});

	test("every reason has a human label", () => {
		expect(MODEL_SUPPORT_REASON_LABELS["endpoint-down"]).toMatch(/unreachable/);
		expect(MODEL_SUPPORT_REASON_LABELS["model-missing"]).toMatch(/isn't installed/);
		expect(MODEL_SUPPORT_REASON_LABELS["load-failed"]).toMatch(/couldn't load/);
		expect(MODEL_SUPPORT_REASON_LABELS.timeout).toMatch(/too long/);
	});
});
