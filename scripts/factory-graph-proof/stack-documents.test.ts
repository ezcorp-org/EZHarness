import { describe, expect, test } from "bun:test";
import { factoryPoolResources } from "../../src/factory/provisioning/host";
import { GRAPH_PROOF_RESOURCES, HOST_ID, poolDocument, webBinding, webBindingRequest, type StackLayout } from "./stack-documents";

const picked = () => 41_234;

describe("the proof web server's binding", () => {
  test("by default it is loopback on a free port, and the proof calls loopback", () => {
    expect(webBinding({}, picked)).toEqual({ host: "127.0.0.1", port: 41_234, origin: "http://127.0.0.1:41234", apiHost: "127.0.0.1" });
  });

  test("a named tailnet address is listened on and called on, with the origin the browser sends", () => {
    expect(webBinding({ host: "100.77.117.56", port: 39_323, origin: "http://100.77.117.56:39323" }, picked))
      .toEqual({ host: "100.77.117.56", port: 39_323, origin: "http://100.77.117.56:39323", apiHost: "100.77.117.56" });
  });

  test("the wildcard is listened on, the proof calls loopback, and the origin defaults to loopback", () => {
    expect(webBinding({ host: "0.0.0.0" }, picked)).toEqual({ host: "0.0.0.0", port: 41_234, origin: "http://127.0.0.1:41234", apiHost: "127.0.0.1" });
  });

  test("a host that is not an IPv4 address, a port out of range, and an origin that is not a bare http origin are refused", () => {
    expect(() => webBinding({ host: "example.invalid" }, picked)).toThrow("the web host must be an IPv4 address");
    expect(() => webBinding({ host: "::1" }, picked)).toThrow("the web host must be an IPv4 address");
    for (const port of [0, 65_536, 1.5, Number.NaN]) expect(() => webBinding({ port }, picked)).toThrow("the web port must be 1-65535");
    for (const origin of ["https://100.77.117.56:39323", "http://100.77.117.56:39323/settings", "http://user@100.77.117.56:39323"]) {
      expect(() => webBinding({ origin }, picked)).toThrow("the web origin must be a bare http origin");
    }
  });

  test("the request reads PROOF_WEB_HOST, PROOF_WEB_PORT and PROOF_WEB_ORIGIN and leaves each absent one out", () => {
    expect(webBindingRequest({})).toEqual({});
    expect(webBindingRequest({ PROOF_WEB_HOST: "100.77.117.56", PROOF_WEB_PORT: "39323", PROOF_WEB_ORIGIN: "http://100.77.117.56:39323" }))
      .toEqual({ host: "100.77.117.56", port: 39_323, origin: "http://100.77.117.56:39323" });
    expect(webBindingRequest({ PROOF_WEB_HOST: "", PROOF_WEB_PORT: "" })).toEqual({});
  });
});

const layout = { root: "/run/w19a", poolDatabase: "pool_w19a", poolUrl: "postgres://pool_role:x@127.0.0.1:5432/pool_w19a", ports: { pool: 41_002 } } as unknown as StackLayout;

test("the graph proof's pool runs the fleet's cpu-only resource profile: the fleet host's own resources, no GPU host (W4H-35 G10)", () => {
  expect(GRAPH_PROOF_RESOURCES).toEqual({ profile: "cpu-only", cpuCapacity: 4 });
  expect(poolDocument(layout).resources).toEqual(factoryPoolResources(GRAPH_PROOF_RESOURCES, HOST_ID));
  expect(poolDocument(layout).resources).toEqual({ capacities: { cpu: 4 }, gpuHosts: [], hosts: [HOST_ID] });
});

test("the pool document follows the profile it is given, so a hand-written resource block cannot stand in for it", () => {
  const gpu = { profile: "gpu", cpuCapacity: 2, gpuProfilesPath: "/srv/operator/gpu-host-profiles.json" } as const;
  expect(poolDocument(layout, gpu).resources).toEqual(factoryPoolResources(gpu, HOST_ID));
  expect(poolDocument(layout, gpu).resources.gpuHosts).toEqual([HOST_ID]);
});
