import { test } from "bun:test";
import { verifyFactoryHostLaunchLostResult } from "../__tests__/helpers/factory-host-launch-suite";

// The helper asserts every step itself; awaiting it directly keeps its own failure message.
test("W01h: on a real Podman guest, a container that exits is recorded failed by name, its retry completes, and a slow guest is collected", async () => {
  await verifyFactoryHostLaunchLostResult();
}, 300_000);
