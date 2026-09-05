import { expect, test, vi } from "vitest";
import { readBoundedJson } from "$lib/server/security/bounded-json";
import { admitRequestPayload, getMaxPayload, readBoundedBody } from "$lib/server/security/payload";

test("bounds advertised and streamed byte lengths before JSON parsing", async () => {
  for (const length of ["9", "bad"]) {
    await expect(readBoundedJson(new Request("http://localhost", { method: "POST", body: "{}", headers: { "content-length": length } }), 8)).rejects.toMatchObject({ status: 413 });
  }
  const cancel = vi.fn();
  const request = { headers: new Headers(), body: new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(9)); }, cancel }) } as Request;
  await expect(readBoundedJson(request, 8)).rejects.toMatchObject({ status: 413 });
  expect(cancel).toHaveBeenCalledOnce();
});

test("parses split UTF-8 within the cap and rejects absent or malformed JSON", async () => {
  const bytes = new TextEncoder().encode('{"text":"😀"}');
  const request = { headers: new Headers(), body: new ReadableStream({ start(controller) { controller.enqueue(bytes.slice(0, 10)); controller.enqueue(bytes.slice(10)); controller.close(); } }) } as Request;
  expect(await readBoundedJson(request, bytes.length)).toEqual({ text: "😀" });
  await expect(readBoundedJson(new Request("http://localhost"), 8)).rejects.toThrow("required");
  await expect(readBoundedJson(new Request("http://localhost", { method: "POST", body: "bad" }), 8)).rejects.toThrow();
  await expect(readBoundedJson(new Request("http://localhost", { method: "POST", body: new Uint8Array([255]) }), 8)).rejects.toThrow("UTF-8 JSON");
});

test("request admission counts real bytes despite missing or misleading length headers", async () => {
  const maximum = getMaxPayload("/api/auth/login");
  for (const length of [undefined, "1"]) {
    const request = new Request("http://localhost/api/auth/login", { method: "POST", headers: length ? { "content-length": length } : {}, body: new Uint8Array(maximum + 1) });
    await expect(admitRequestPayload(request, "/api/auth/login")).rejects.toMatchObject({ status: 413 });
  }
  const request = new Request("http://localhost/api/auth/login", { method: "POST", headers: { "content-length": "1", "content-type": "application/octet-stream" }, body: new Uint8Array([0, 255, 1]) });
  const admitted = await admitRequestPayload(request, "/api/auth/login");
  expect(admitted.headers.get("content-length")).toBe("3");
  expect(new Uint8Array(await admitted.arrayBuffer())).toEqual(new Uint8Array([0, 255, 1]));
  const empty = new Request("http://localhost");
  expect(await admitRequestPayload(empty, "/api/auth/login")).toBe(empty);
  expect(await readBoundedBody(empty, 8)).toEqual(new Uint8Array());
  expect(getMaxPayload("/api/extensions/control")).toBe(128 * 1024 * 1024);
  expect(getMaxPayload("/api/extensions/control-other")).toBe(25 * 1024 * 1024);
});
