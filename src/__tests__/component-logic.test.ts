import { test, expect, describe } from "bun:test";
import { isBannerVisible, bannerColorClass, } from "../../web/src/lib/connection-banner-logic";
import { isChatDisabled, chatPlaceholder } from "../../web/src/lib/chat-input-logic";
import { statusColor, statusLabel, type SubsystemStatus } from "../../web/src/lib/system-health-logic";

describe("ConnectionBanner logic", () => {
	test("visible when reconnecting", () => {
		expect(isBannerVisible("reconnecting", false)).toBe(true);
	});

	test("visible when failed", () => {
		expect(isBannerVisible("failed", false)).toBe(true);
	});

	test("visible when disconnected", () => {
		expect(isBannerVisible("disconnected", false)).toBe(true);
	});

	test("visible when showConnected=true even if connected", () => {
		expect(isBannerVisible("connected", true)).toBe(true);
	});

	test("NOT visible when connected and showConnected=false", () => {
		expect(isBannerVisible("connected", false)).toBe(false);
	});

	test("green color when showConnected + connected", () => {
		expect(bannerColorClass("connected", true)).toBe("bg-green-600/90 text-white");
	});

	test("red color when failed", () => {
		expect(bannerColorClass("failed", false)).toBe("bg-red-600/90 text-white");
	});

	test("amber color for reconnecting", () => {
		expect(bannerColorClass("reconnecting", false)).toBe("bg-amber-500/90 text-white");
	});

	test("amber color for disconnected", () => {
		expect(bannerColorClass("disconnected", false)).toBe("bg-amber-500/90 text-white");
	});
});

describe("ChatInput logic", () => {
	test("disabled when streaming=true", () => {
		expect(isChatDisabled(true, "connected")).toBe(true);
	});

	test("disabled when connectionState !== connected", () => {
		expect(isChatDisabled(false, "reconnecting")).toBe(true);
	});

	test("not disabled when streaming=false and connected", () => {
		expect(isChatDisabled(false, "connected")).toBe(false);
	});

	test("placeholder is Reconnecting... when not connected", () => {
		expect(chatPlaceholder("reconnecting", "Send a message...")).toBe("Reconnecting...");
	});

	test("placeholder is default when connected", () => {
		expect(chatPlaceholder("connected", "Send a message...")).toBe("Send a message...");
	});
});

describe("SystemHealth logic", () => {
	test("green for up", () => {
		expect(statusColor("up")).toBe("bg-green-500");
	});

	test("green for ready", () => {
		expect(statusColor("ready")).toBe("bg-green-500");
	});

	test("green for configured", () => {
		expect(statusColor("configured")).toBe("bg-green-500");
	});

	test("red for down", () => {
		expect(statusColor("down")).toBe("bg-red-500");
	});

	test("red for not_initialized", () => {
		expect(statusColor("not_initialized")).toBe("bg-red-500");
	});

	test("red for not_configured", () => {
		expect(statusColor("not_configured")).toBe("bg-red-500");
	});

	test("gray for unknown status", () => {
		expect(statusColor("something_else" as SubsystemStatus)).toBe("bg-gray-500");
	});

	test("statusLabel replaces underscores with spaces", () => {
		expect(statusLabel("not_initialized")).toBe("not initialized");
		expect(statusLabel("not_configured")).toBe("not configured");
		expect(statusLabel("up")).toBe("up");
	});
});
