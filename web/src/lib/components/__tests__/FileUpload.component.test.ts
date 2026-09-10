import { afterEach, describe, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/svelte";
import FileUpload from "../FileUpload.svelte";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

function file(name: string, content = "hello", type = "text/plain") {
	return new File([content], name, { type });
}
function response(body: unknown, status = 200) {
	return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("FileUpload", () => {
	test("uploads allowed files from the picker and reports successful completion", async () => {
		const onuploaded = vi.fn();
		const fetchMock = vi.fn().mockResolvedValue(response({ id: "kb-1" }));
		vi.stubGlobal("fetch", fetchMock);
		render(FileUpload, { props: { projectId: "project-1", onuploaded } });
		const input = document.querySelector('input[type="file"]') as HTMLInputElement;
		await fireEvent.change(input, { target: { files: [file("notes.md")] } });
		await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
		const [url, init] = fetchMock.mock.calls[0]!;
		expect(url).toBe("/api/knowledge-base");
		expect(init.method).toBe("POST");
		const body = init.body as FormData;
		expect(body.get("projectId")).toBe("project-1");
		expect((body.get("file") as File).name).toBe("notes.md");
		await waitFor(() => expect(screen.getByText("notes.md")).toBeTruthy());
		expect(onuploaded).toHaveBeenCalledTimes(1);
		const dropZone = screen.getByRole("button", { name: /Drop files here or click to upload/ });
		const click = vi.spyOn(input, "click");
		await fireEvent.keyDown(dropZone, { key: "Enter" });
		expect(click).toHaveBeenCalled();
	});

	test("rejects unsupported and oversized files before sending a request", async () => {
		const fetchMock = vi.fn();
		vi.stubGlobal("fetch", fetchMock);
		render(FileUpload, { props: { projectId: "project-1", onuploaded: vi.fn() } });
		const input = document.querySelector('input[type="file"]') as HTMLInputElement;
		await fireEvent.change(input, { target: { files: [file("malware.exe")] } });
		await waitFor(() => expect(screen.getByText(/unsupported type/)).toBeTruthy());
		const large = new File([new Uint8Array(10 * 1024 * 1024 + 1)], "large.md", { type: "text/markdown" });
		await fireEvent.change(input, { target: { files: [large] } });
		await waitFor(() => expect(screen.getByText(/exceeds 10MB limit/)).toBeTruthy());
		expect(fetchMock).not.toHaveBeenCalled();
	});

	test("shows drag affordance and supports keyboard picker activation", async () => {
		render(FileUpload, { props: { projectId: "project-1", onuploaded: vi.fn() } });
		const dropZone = screen.getByRole("button", { name: /Drop files here or click to upload/ });
		const input = document.querySelector('input[type="file"]') as HTMLInputElement;
		const click = vi.spyOn(input, "click");
		await fireEvent.dragOver(dropZone);
		expect(screen.getByText("Drop files here")).toBeTruthy();
		await fireEvent.dragLeave(dropZone);
		await fireEvent.keyDown(dropZone, { key: "Enter" });
		expect(click).toHaveBeenCalled();
	});
});
