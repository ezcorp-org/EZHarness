import { fireEvent, render, screen, waitFor } from "@testing-library/svelte";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { FactoryArtifactResource } from "@ezcorp/factory-sdk/types";
import FactoryArtifactPreview from "./FactoryArtifactPreview.svelte";
import { FACTORY_PREVIEW_IMAGE_BYTES, type FactoryImageCodec } from "./preview";

const encoder = new TextEncoder();
const artifact: FactoryArtifactResource = { artifactId: "artifact-1", kind: "candidate_output", digest: `sha256:${"a".repeat(64)}`, encodedBytes: 8, nodeInstanceId: "render-report", createdAtMs: 1 };
const ticket = (encodedBytes: number) => ({ url: "/download?ticket=x", expiresAtMs: 1, mediaType: "application/octet-stream", encodedBytes });

function mount(bytes: Uint8Array | Error, options: { size?: number; codec?: FactoryImageCodec; artifact?: FactoryArtifactResource } = {}) {
	const onClose = vi.fn();
	const api = {
		artifactTicket: vi.fn(async () => ticket(options.size ?? (bytes instanceof Uint8Array ? bytes.byteLength : 1))),
		artifactBytes: vi.fn(async () => { if (bytes instanceof Error) throw bytes; return bytes; }),
	};
	const result = render(FactoryArtifactPreview, { projectId: "p", runId: "r", artifact: options.artifact ?? artifact, api, onClose, ...(options.codec ? { codec: options.codec } : {}) });
	return { ...result, api, onClose };
}

beforeEach(() => {
	vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:preview");
	vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
});
afterEach(() => { vi.restoreAllMocks(); });

describe("FactoryArtifactPreview", () => {
	test("markup is escaped source with a warning, and the dialog takes focus and gives it back", async () => {
		const opener = document.createElement("button");
		document.body.append(opener);
		opener.focus();
		const { unmount, onClose } = mount(encoder.encode("<script>alert(1)</script>"));
		const text = await screen.findByTestId("factory-artifact-text");
		expect(text.textContent).toBe("<script>alert(1)</script>");
		expect(text.querySelector("script")).toBeNull();
		expect(screen.getByText("This is markup. It is shown as source and is never rendered.")).toBeVisible();
		await waitFor(() => expect(screen.getByRole("button", { name: "Close artifact preview" })).toHaveFocus());
		expect(screen.getByRole("heading", { name: "render-report" })).toBeVisible();
		expect(screen.getByText("candidate output")).toBeVisible();
		await fireEvent.keyDown(window, { key: "Escape" });
		await fireEvent.keyDown(window, { key: "a" });
		expect(onClose).toHaveBeenCalledTimes(1);
		unmount();
		expect(opener).toHaveFocus();
		opener.remove();
	});

	test("JSON is pretty-printed, a long text says it was cut, and the backdrop closes the dialog", async () => {
		const { onClose, unmount } = mount(encoder.encode('{"a":1}'));
		expect((await screen.findByTestId("factory-artifact-text")).textContent).toBe('{\n  "a": 1\n}');
		await fireEvent.click(screen.getByRole("dialog"));
		expect(onClose).not.toHaveBeenCalled();
		await fireEvent.click(screen.getByRole("presentation"));
		expect(onClose).toHaveBeenCalledTimes(1);
		unmount();
		mount(encoder.encode("plain"), { size: 70_000 });
		expect(await screen.findByText("Only the first 64 KiB is shown. Download the artifact for the rest.")).toBeVisible();
	});

	test("a raster is re-encoded before it is shown, and its object URL is released", async () => {
		const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0]);
		const codec: FactoryImageCodec = { decode: vi.fn(async () => ({ width: 2, height: 1, close: vi.fn() })), encode: vi.fn(async () => new Blob([png], { type: "image/png" })) };
		const { unmount } = mount(png, { codec, artifact: { ...artifact, nodeInstanceId: undefined } });
		const image = await screen.findByRole("img");
		expect(image.getAttribute("src")).toBe("blob:preview");
		expect(image.getAttribute("alt")).toBe("Re-encoded preview of artifact-1");
		expect(screen.getByRole("heading", { name: "artifact-1" })).toBeVisible();
		unmount();
		expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:preview");
	});

	test("binary, oversized, and unreadable artifacts are download-only, and download works from the dialog", async () => {
		const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
		const binary = mount(new Uint8Array([1, 0, 2]));
		expect(await screen.findByText("Binary content is download-only.")).toBeVisible();
		await fireEvent.click(screen.getByRole("button", { name: /Download/ }));
		await waitFor(() => expect(click).toHaveBeenCalledTimes(1));
		binary.api.artifactTicket.mockRejectedValueOnce(new Error("ticket refused"));
		await fireEvent.click(screen.getByRole("button", { name: /Download/ }));
		expect(await screen.findByRole("alert")).toHaveTextContent("ticket refused");
		binary.unmount();
		const big = mount(new Uint8Array([1]), { size: FACTORY_PREVIEW_IMAGE_BYTES + 1 });
		expect(await screen.findByText("The artifact is larger than the preview limit.")).toBeVisible();
		expect(big.api.artifactBytes).not.toHaveBeenCalled();
		big.unmount();
		mount(new Error("read refused"));
		expect(await screen.findByRole("alert")).toHaveTextContent("read refused");
	});

	test("a non-Error failure still reads as a sentence", async () => {
		const api = { artifactTicket: vi.fn(async () => { throw "nope"; }), artifactBytes: vi.fn() };
		render(FactoryArtifactPreview, { projectId: "p", runId: "r", artifact, api, onClose: vi.fn() });
		expect(await screen.findByRole("alert")).toHaveTextContent("The artifact could not be read.");
		await fireEvent.click(screen.getByRole("button", { name: /Download/ }));
		await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("The artifact could not be downloaded."));
	});
});
