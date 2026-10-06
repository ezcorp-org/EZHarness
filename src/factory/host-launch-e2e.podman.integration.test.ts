import { test } from "bun:test";
import { verifyFactoryHostLaunchEndToEnd } from "../__tests__/helpers/factory-host-launch-suite";

// Awaited directly so a rejection reaches the report with its message (W4H-12); the helper asserts.
test("a queued attempt runs in a real Podman guest through the supervisor process and its outcome is durable", async () => {
  await verifyFactoryHostLaunchEndToEnd();
}, 300_000);
