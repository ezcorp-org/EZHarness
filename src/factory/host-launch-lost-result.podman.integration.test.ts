import { expect, test } from "bun:test";
import { verifyFactoryHostLaunchLostResult } from "../__tests__/helpers/factory-host-launch-suite";

// The helper asserts every step itself and returns what each attempt's terminal row says.
test("W01h: on a real Podman guest, a container that exits is recorded failed by name, its retry runs, and a slow guest is collected", async () => {
  expect(await verifyFactoryHostLaunchLostResult()).toEqual({ exited: "RUNNER_CONTAINER_EXIT", retried: "cancelled", slow: "cancelled" });
}, 300_000);
