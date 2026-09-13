import { afterEach, expect, test, vi } from "vitest";
import { downloadFactorySource } from "./download";

afterEach(() => vi.restoreAllMocks());

test("downloads an exported factory source and revokes its object URL", () => {
	const createObjectURL = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:factory");
	const revokeObjectURL = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
	const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
	downloadFactorySource("factory-one", "yaml", "schemaVersion: factory.v1");
	expect(createObjectURL).toHaveBeenCalledWith(expect.any(Blob));
	expect(click).toHaveBeenCalledOnce();
	expect(revokeObjectURL).toHaveBeenCalledWith("blob:factory");
});
