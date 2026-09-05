import { expect, test } from "bun:test";
import { McpClient } from "../mcp/client";

test("base MCP client skips pre-aborted connections and cancels one real stdio request without replay", async () => {
  const script = `let count=0;let buffer="";const send=value=>process.stdout.write(JSON.stringify(value)+"\\n");process.stdin.on("data",chunk=>{buffer+=chunk;let newline;while((newline=buffer.indexOf("\\n"))>=0){const line=buffer.slice(0,newline);buffer=buffer.slice(newline+1);if(!line)continue;const request=JSON.parse(line);if(request.method==="initialize")send({jsonrpc:"2.0",id:request.id,result:{protocolVersion:request.params.protocolVersion,capabilities:{tools:{listChanged:true}},serverInfo:{name:"cancel",version:"1"}}});else if(request.method==="tools/call"){if(request.params.name==="wait"){count++;send({jsonrpc:"2.0",method:"notifications/tools/list_changed"});}else send({jsonrpc:"2.0",id:request.id,result:{content:[{type:"text",text:String(count)}],isError:false}});}}});`;
  const client = new McpClient({ name: "cancel", transport: "stdio", command: process.execPath, args: ["-e", script] });
  const cancelled = new AbortController();
  cancelled.abort(new Error("Already stopped"));
  await expect(client.callTool("wait", {}, undefined, { signal: cancelled.signal })).rejects.toThrow("Already stopped");
  expect(client.isConnected).toBe(false);
  const controller = new AbortController();
  let arrived!: () => void;
  const started = new Promise<void>(resolve => { arrived = resolve; });
  client.setLifecycleHooks({ onToolListChanged: arrived });
  try {
    const outcome = client.callTool("wait", {}, undefined, { signal: controller.signal }).then(() => false, () => true);
    await started;
    controller.abort(new Error("Caller stopped"));
    expect(await outcome).toBe(true);
    expect(await client.callTool("count", {})).toEqual({ content: [{ type: "text", text: "1" }], isError: false });
  } finally { await client.close(); }
});
