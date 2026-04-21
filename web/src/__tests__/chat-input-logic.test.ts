import { test, expect, describe } from "bun:test";
import { isChatDisabled, chatPlaceholder } from "../lib/chat-input-logic";

describe("isChatDisabled", () => {
	test("disabled when streaming", () => {
		expect(isChatDisabled(true, "connected")).toBe(true);
	});

	test("disabled when disconnected", () => {
		expect(isChatDisabled(false, "disconnected")).toBe(true);
	});

	test("disabled when reconnecting", () => {
		expect(isChatDisabled(false, "reconnecting")).toBe(true);
	});

	test("disabled when failed", () => {
		expect(isChatDisabled(false, "failed")).toBe(true);
	});

	test("enabled when connected and not streaming", () => {
		expect(isChatDisabled(false, "connected")).toBe(false);
	});

	test("disabled when streaming AND disconnected", () => {
		expect(isChatDisabled(true, "disconnected")).toBe(true);
	});
});

describe("chatPlaceholder", () => {
	test("returns default when connected", () => {
		expect(chatPlaceholder("connected", "Send a message...")).toBe("Send a message...");
	});

	test("returns reconnecting message when disconnected", () => {
		expect(chatPlaceholder("disconnected", "Send a message...")).toBe("Reconnecting...");
	});

	test("returns reconnecting message when reconnecting", () => {
		expect(chatPlaceholder("reconnecting", "Send a message...")).toBe("Reconnecting...");
	});

	test("returns reconnecting message when failed", () => {
		expect(chatPlaceholder("failed", "Send a message...")).toBe("Reconnecting...");
	});
});
