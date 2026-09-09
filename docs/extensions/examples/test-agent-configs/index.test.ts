import { afterEach, expect, spyOn, test } from "bun:test";
import { getChannel } from "@ezcorp/sdk/runtime";
import { tools, start } from "./index";

afterEach(() => { request?.mockRestore(); });
let request: ReturnType<typeof spyOn> | undefined;
test("agent configs list and resolve preserve host results", async () => {
  const config = { id: "config", name: "Agent" };
  request = spyOn(getChannel(), "request").mockResolvedValueOnce({ v: 1, configs: [config] }).mockResolvedValueOnce({ v: 1, config });
  expect(await tools.list_configs!({})).toMatchObject({ content: [{ text: JSON.stringify([config]) }], isError: false });
  expect(await tools.resolve_config!({ idOrName: "Agent" })).toMatchObject({ content: [{ text: JSON.stringify(config) }], isError: false });
  expect(request).toHaveBeenNthCalledWith(1, "ezcorp/agent-configs", { v: 1, action: "list" });
  expect(request).toHaveBeenNthCalledWith(2, "ezcorp/agent-configs", { v: 1, action: "resolve", idOrName: "Agent" });
});
test("agent config invalid arguments and host errors stay tool errors", async () => {
  request = spyOn(getChannel(), "request").mockRejectedValue(new Error("denied"));
  expect(await tools.resolve_config!({ idOrName: 1 })).toMatchObject({ content: [{ text: "resolve_config requires string 'idOrName'" }], isError: true });
  expect(request).not.toHaveBeenCalled();
  expect(await tools.list_configs!({})).toMatchObject({ content: [{ text: "list failed: denied" }], isError: true });
  expect(await tools.resolve_config!({ idOrName: "Agent" })).toMatchObject({ content: [{ text: "resolve failed: denied" }], isError: true });
});
test("agent config start registers without needing stdin in tests", () => {
  const channel = getChannel();
  const run = spyOn(channel, "start").mockImplementation(() => {});
  const register = spyOn(channel, "onRequest");
  try { start(); expect(run).toHaveBeenCalledTimes(1); expect(register).toHaveBeenCalledWith("tools/call", expect.any(Function)); }
  finally { run.mockRestore(); register.mockRestore(); }
});
