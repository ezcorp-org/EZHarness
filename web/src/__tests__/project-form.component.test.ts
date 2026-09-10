import "@testing-library/jest-dom/vitest";
import { fireEvent, render, waitFor } from "@testing-library/svelte";
import { afterEach, describe, expect, test, vi } from "vitest";

const { createDir, fetchFavicon } = vi.hoisted(() => ({ createDir: vi.fn(), fetchFavicon: vi.fn() }));
vi.mock("$lib/api.js", () => ({ createDir, fetchFavicon }));
import ProjectForm from "$lib/components/ProjectForm.svelte";

afterEach(() => { createDir.mockReset(); fetchFavicon.mockReset(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("ProjectForm", () => {
	test("creates the requested folder and submits its resolved path", async () => {
		createDir.mockResolvedValue({ path: "/work/new-project" });
		const onsubmit = vi.fn();
		const { getByLabelText, getByRole, getByText, getByPlaceholderText } = render(ProjectForm, { onsubmit });
		await fireEvent.input(getByLabelText("Name"), { target: { value: "New project" } });
		const path = getByPlaceholderText("/app/web/.ezcorp/projects/my-project");
		await fireEvent.input(path, { target: { value: "/work/new-project" } });
		await fireEvent.click(getByText("Create Folder"));
		await waitFor(() => expect(getByText("Created /work/new-project")).toBeInTheDocument());
		await fireEvent.submit(getByRole("button", { name: "Create" }).closest("form")!);
		expect(onsubmit).toHaveBeenCalledWith({ name: "New project", path: "/work/new-project", icon: null, variables: {} });
	});

	test("shows directory and favicon failures, then submits a fetched icon", async () => {
		createDir.mockRejectedValue(new Error("Path is not writable"));
		fetchFavicon.mockRejectedValueOnce(new Error("No favicon found")).mockResolvedValueOnce("data:image/png;base64,icon");
		const onsubmit = vi.fn();
		const { getByPlaceholderText, getByText, getByRole } = render(ProjectForm, { onsubmit, project: { name: "Existing", path: "/repo", icon: null, variables: { KEEP: true } } });
		await fireEvent.click(getByText("Create Folder"));
		await waitFor(() => expect(getByText("Path is not writable")).toBeInTheDocument());
		const favicon = getByPlaceholderText("https://example.com");
		await fireEvent.input(favicon, { target: { value: "https://example.test" } });
		await fireEvent.click(getByText("Fetch"));
		await waitFor(() => expect(getByText("No favicon found")).toBeInTheDocument());
		await fireEvent.click(getByText("Fetch"));
		await waitFor(() => expect(getByRole("img", { name: "Project icon" })).toBeInTheDocument());
		await fireEvent.submit(getByRole("button", { name: "Update" }).closest("form")!);
		expect(onsubmit).toHaveBeenCalledWith({ name: "Existing", path: "/repo", icon: "data:image/png;base64,icon", variables: { KEEP: true } });
	});
});

test("turns an uploaded image into the scaled icon sent on submit", async () => {
	class Reader {
		result: string | ArrayBuffer | null = "data:image/source";
		onload: ((event: ProgressEvent<FileReader>) => void) | null = null;
		readAsDataURL() { this.onload?.(new ProgressEvent("load") as ProgressEvent<FileReader>); }
	}
	class DecodedImage {
		onload: (() => void) | null = null;
		set src(_value: string) { this.onload?.(); }
	}
	vi.stubGlobal("FileReader", Reader);
	vi.stubGlobal("Image", DecodedImage);
	vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({ drawImage: vi.fn() } as unknown as CanvasRenderingContext2D);
	vi.spyOn(HTMLCanvasElement.prototype, "toDataURL").mockReturnValue("data:image/png;base64,resized");
	const onsubmit = vi.fn();
	const { container, getByLabelText, getByRole } = render(ProjectForm, { onsubmit });
	await fireEvent.input(getByLabelText("Name"), { target: { value: "Image project" } });
	const upload = container.querySelector<HTMLInputElement>('input[type="file"]')!;
	await fireEvent.change(upload, { target: { files: [new File(["image"], "icon.png", { type: "image/png" })] } });
	await waitFor(() => expect(getByRole("img", { name: "Project icon" })).toBeInTheDocument());
	await fireEvent.submit(getByRole("button", { name: "Create" }).closest("form")!);
	expect(onsubmit).toHaveBeenCalledWith(expect.objectContaining({ icon: "data:image/png;base64,resized" }));
});
