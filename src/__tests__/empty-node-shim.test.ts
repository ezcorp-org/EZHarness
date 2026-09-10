import { expect, test } from "bun:test";
import nodeAlias from "../../web/src/lib/empty-node-shim.ts";

test("the browser Node alias exposes no filesystem or path API", () => {
	expect(Object.keys(nodeAlias)).toEqual([]);
	expect("readFile" in nodeAlias).toBe(false);
	expect("resolve" in nodeAlias).toBe(false);
});
