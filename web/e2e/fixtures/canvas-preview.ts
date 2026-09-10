import type { Page } from "@playwright/test";

export async function mockCanvasPreview(page: Page, filename = "preview.html"): Promise<void> {
	await page.route(`**/api/extensions/claude-design/data/${filename}`, (route) => route.fulfill({
		contentType: "text/html",
		body: `<!doctype html><html><body style="margin:0;background:#f8fafc;font:16px system-ui;color:#172033"><main style="padding:48px"><p style="color:#6366f1;font-weight:700">CLAUDE DESIGN</p><h1>Quarterly planning canvas</h1><p>Move the controls to refine spacing, color, and density.</p></main></body></html>`,
	}));
}


export const canvasPreviewPayload = {
	draftId: "d-1",
	iframeSrc: "/api/extensions/claude-design/data/preview.html",
	knobsTitle: "Design controls",
	knobs: [
		{ key: "primaryColor", label: "Primary color", kind: "color", current: "#4f46e5" },
		{ key: "secondaryColor", label: "Secondary color", kind: "color", current: "#0ea5e9" },
		{ key: "spacingScale", label: "Spacing scale", kind: "range", behavior: "scale-spacing", min: -25, max: 50, step: 5, unit: "%", current: "0" },
		{ key: "borderRadius", label: "Border radius", kind: "range", min: 0, max: 24, step: 2, unit: "px", current: "12" },
		{ key: "density", label: "Density", kind: "select", options: ["compact", "cozy", "spacious"], current: "cozy" },
	],
	knobValues: { primaryColor: "#4f46e5", secondaryColor: "#0ea5e9", spacingScale: "+0%", borderRadius: "12px", density: "cozy" },
};
