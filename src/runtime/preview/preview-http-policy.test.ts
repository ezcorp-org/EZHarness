import { expect, test } from "bun:test";
import { configurePreviewHttpResponse, HTTP_SETTLEMENT_MS, PREVIEW_HTTP_RESPONSE_MS } from "./preview-http-policy";

test("HTTP policy keeps one finite response budget and applies only to a live raw request", () => {
  expect(PREVIEW_HTTP_RESPONSE_MS).toBe(60_000);
  expect(HTTP_SETTLEMENT_MS).toBe(5_000);
  const calls: unknown[] = [];
  const server = { timeout: (...args: unknown[]) => { calls.push(args); } };
  configurePreviewHttpResponse();
  configurePreviewHttpResponse({ server, request: {} });
  const request = new Request("http://preview.example/");
  configurePreviewHttpResponse({ request });
  configurePreviewHttpResponse({ request, server: {} });
  expect(calls).toEqual([]);
  configurePreviewHttpResponse({ request, server });
  expect(calls).toEqual([[request, 60]]);
});
