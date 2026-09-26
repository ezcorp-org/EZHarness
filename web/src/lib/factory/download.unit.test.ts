import { afterEach, expect, test, vi } from "vitest";
import { downloadFactorySource } from "./download";

afterEach(() => vi.restoreAllMocks());

test.each([
	{ format: "yaml" as const, source: "schemaVersion: factory.v1\n", type: "application/yaml", fileName: "factory-one.yaml" },
	{ format: "json" as const, source: '{"schemaVersion":"factory.v1"}', type: "application/json", fileName: "factory-one.json" },
])("downloads the $format source as $fileName ($type), then revokes its object URL", async ({ format, source, type, fileName }) => {
	const order: string[] = [];
	const createObjectURL = vi.spyOn(URL, "createObjectURL").mockImplementation(() => {
		order.push("create");
		return "blob:factory";
	});
	const revokeObjectURL = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {
		order.push("revoke");
	});
	let clicked: HTMLAnchorElement | undefined;
	vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
		order.push("click");
		clicked = this;
	});

	downloadFactorySource("factory-one", format, source);

	expect(createObjectURL).toHaveBeenCalledOnce();
	const blob = createObjectURL.mock.calls[0]![0] as Blob;
	expect(blob.type).toBe(type);
	expect(await blob.text()).toBe(source);
	expect(clicked?.href).toBe("blob:factory");
	expect(clicked?.download).toBe(fileName);
	expect(revokeObjectURL).toHaveBeenCalledWith("blob:factory");
	expect(order).toEqual(["create", "click", "revoke"]);
});
