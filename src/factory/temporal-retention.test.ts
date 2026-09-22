import { describe, expect, test } from "bun:test";
import { FACTORY_TEMPORAL_HISTORY_RETENTION_DAYS, factoryTemporalNamespaceArguments, FactoryTemporalHttpPositions, FactoryTemporalRetentionError, verifyFactoryTemporalRetention } from "./temporal-retention";

type Handler = (url: URL, init: RequestInit & { tls?: unknown }) => Response | Promise<Response>;
function fakeFetch(handler: Handler) {
  const calls: { url: string; tls?: unknown }[] = [];
  const fetcher = (async (input: URL, init: RequestInit & { tls?: unknown }) => { calls.push({ url: input.toString(), tls: init.tls }); return handler(input, init); }) as unknown as typeof fetch;
  return { fetcher, calls };
}

const ready = { config: { workflowExecutionRetentionTtl: `${30 * 86_400}s`, historyArchivalState: "ARCHIVAL_STATE_ENABLED", historyArchivalUri: "file:///archive/history", visibilityArchivalState: "ARCHIVAL_STATE_ENABLED" } };

describe("Temporal history retention and archival", () => {
  test("a namespace with thirty days of history and both archivals enabled is ready", async () => {
    const { fetcher, calls } = fakeFetch(() => Response.json(ready));
    const report = await verifyFactoryTemporalRetention({ endpoint: "https://temporal.internal:7243", namespace: "tenant-a", fetch: fetcher, tls: { cert: "c", key: "k", ca: "a" } });
    expect(report).toEqual({ namespace: "tenant-a", retentionSeconds: 2_592_000, historyArchival: "ARCHIVAL_STATE_ENABLED", historyArchiveUri: "file:///archive/history", visibilityArchival: "ARCHIVAL_STATE_ENABLED", ready: true, unmet: [] });
    expect(calls).toEqual([{ url: "https://temporal.internal:7243/api/v1/namespaces/tenant-a", tls: { cert: "c", key: "k", ca: "a" } }]);
  });

  test("every unmet criterion is named, and nothing is changed", async () => {
    const { fetcher } = fakeFetch(() => Response.json({ config: { workflowExecutionRetentionTtl: "86400s", historyArchivalState: "ARCHIVAL_STATE_DISABLED" } }));
    const report = await verifyFactoryTemporalRetention({ endpoint: "http://127.0.0.1:1", namespace: "tenant-a", fetch: fetcher });
    expect(report.ready).toBe(false);
    expect(report.unmet).toEqual(["history-retention-below-30-days", "history-archival-disabled", "visibility-archival-disabled"]);
    const noConfig = fakeFetch(() => Response.json({}));
    await expect(verifyFactoryTemporalRetention({ endpoint: "http://127.0.0.1:1", namespace: "tenant-a", fetch: noConfig.fetcher })).rejects.toMatchObject({ code: "factory_temporal_response_invalid" });
  });

  test("an unreachable, refusing, or malformed server is an error, never a pass", async () => {
    const unreachable = fakeFetch(() => { throw new Error("connection refused"); });
    await expect(verifyFactoryTemporalRetention({ endpoint: "http://127.0.0.1:1", namespace: "n", fetch: unreachable.fetcher })).rejects.toMatchObject({ code: "factory_temporal_unreachable" });
    const refusing = fakeFetch(() => Response.json({ message: "no" }, { status: 403 }));
    await expect(verifyFactoryTemporalRetention({ endpoint: "http://127.0.0.1:1", namespace: "n", fetch: refusing.fetcher })).rejects.toMatchObject({ code: "factory_temporal_unreachable" });
    const empty = fakeFetch(() => new Response("", { status: 200 }));
    await expect(verifyFactoryTemporalRetention({ endpoint: "http://127.0.0.1:1", namespace: "n", fetch: empty.fetcher })).rejects.toMatchObject({ code: "factory_temporal_response_invalid" });
    const garbage = fakeFetch(() => new Response("{not json", { status: 200 }));
    await expect(verifyFactoryTemporalRetention({ endpoint: "http://127.0.0.1:1", namespace: "n", fetch: garbage.fetcher })).rejects.toMatchObject({ code: "factory_temporal_response_invalid" });
    await expect(verifyFactoryTemporalRetention({ endpoint: "not a url", namespace: "n" })).rejects.toMatchObject({ code: "factory_temporal_invalid" });
    await expect(verifyFactoryTemporalRetention({ endpoint: "ftp://temporal", namespace: "n" })).rejects.toMatchObject({ code: "factory_temporal_invalid" });
  });

  test("positions come from DescribeWorkflowExecution; an unknown workflow reads as not found at length zero", async () => {
    const { fetcher, calls } = fakeFetch(url => url.pathname.endsWith(encodeURIComponent("tenant/run-missing"))
      ? Response.json({ message: "workflow not found" }, { status: 404 })
      : Response.json({ workflowExecutionInfo: { execution: { workflowId: "x", runId: "run-7" }, status: "WORKFLOW_EXECUTION_STATUS_RUNNING", historyLength: "42" } }));
    const positions = new FactoryTemporalHttpPositions({ endpoint: "http://127.0.0.1:7243", namespace: "tenant-ns", fetch: fetcher });
    expect(positions.namespace).toBe("tenant-ns");
    expect(await positions.positions(["tenant/run-live", "tenant/run-missing"], new AbortController().signal)).toEqual([
      { workflowId: "tenant/run-live", runId: "run-7", status: "WORKFLOW_EXECUTION_STATUS_RUNNING", historyLength: 42 },
      { workflowId: "tenant/run-missing", runId: null, status: "not_found", historyLength: 0 },
    ]);
    expect(calls[0]!.url).toBe(`http://127.0.0.1:7243/api/v1/namespaces/tenant-ns/workflows/${encodeURIComponent("tenant/run-live")}`);
    const bad = new FactoryTemporalHttpPositions({ endpoint: "http://127.0.0.1:7243", namespace: "tenant-ns", fetch: fakeFetch(() => Response.json({ workflowExecutionInfo: { status: "RUNNING", historyLength: "-1" } })).fetcher });
    await expect(bad.positions(["w"])).rejects.toBeInstanceOf(FactoryTemporalRetentionError);
    const noRun = new FactoryTemporalHttpPositions({ endpoint: "http://127.0.0.1:7243", namespace: "tenant-ns", fetch: fakeFetch(() => Response.json({ workflowExecutionInfo: { status: "WORKFLOW_EXECUTION_STATUS_COMPLETED", historyLength: 3 } })).fetcher });
    expect(await noRun.positions(["w"])).toEqual([{ workflowId: "w", runId: null, status: "WORKFLOW_EXECUTION_STATUS_COMPLETED", historyLength: 3 }]);
    expect(() => new FactoryTemporalHttpPositions({ endpoint: "http://x", namespace: "bad namespace" })).toThrow(FactoryTemporalRetentionError);
  });

  test("the provisioner's namespace arguments carry the thirty-day retention and both archive URIs", () => {
    expect(factoryTemporalNamespaceArguments("tenant-a", "file:///archive/history", "file:///archive/visibility")).toEqual([
      "--namespace", "tenant-a", "--retention", `${FACTORY_TEMPORAL_HISTORY_RETENTION_DAYS * 24}h`,
      "--history-archival-state", "enabled", "--history-uri", "file:///archive/history",
      "--visibility-archival-state", "enabled", "--visibility-uri", "file:///archive/visibility",
    ]);
    for (const [namespace, history, visibility] of [["", "s3://a", "s3://b"], ["ok", "not-a-uri", "s3://b"], ["ok", "s3://a", ""]] as const) {
      expect(() => factoryTemporalNamespaceArguments(namespace, history, visibility)).toThrow(FactoryTemporalRetentionError);
    }
  });
});
