import { afterEach, expect, test, vi } from "vitest";
import { downloadFactorySource } from "./download";

afterEach(() => vi.restoreAllMocks());

async function capture(format: "json" | "yaml", source: string) {
	const blobs: Blob[] = [];
	const createObjectURL = vi.spyOn(URL, "createObjectURL").mockImplementation(blob => { blobs.push(blob as Blob); return "blob:factory"; });
	const revokeObjectURL = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
	const links: HTMLAnchorElement[] = [];
	vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) { links.push(this); });
	downloadFactorySource("factory-one", format, source);
	return { blob: blobs[0]!, link: links[0]!, createObjectURL, revokeObjectURL, text: await blobs[0]!.text() };
}

test("downloads exported YAML as a named file and revokes its object URL", async () => {
	const result = await capture("yaml", "schemaVersion: factory.v1");
	expect(result.createObjectURL).toHaveBeenCalledOnce();
	expect(result.blob.type).toBe("application/yaml");
	expect(result.text).toBe("schemaVersion: factory.v1");
	expect(result.link.download).toBe("factory-one.yaml");
	expect(result.link.href).toBe("blob:factory");
	expect(result.revokeObjectURL).toHaveBeenCalledWith("blob:factory");
});

test("downloads exported JSON with the JSON media type", async () => {
	const result = await capture("json", '{"schemaVersion":"factory.v1"}');
	expect(result.blob.type).toBe("application/json");
	expect(result.text).toBe('{"schemaVersion":"factory.v1"}');
	expect(result.link.download).toBe("factory-one.json");
});
