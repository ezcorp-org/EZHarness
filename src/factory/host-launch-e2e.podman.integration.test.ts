import { expect, test } from "bun:test";
import { verifyFactoryHostLaunchEndToEnd } from "../__tests__/helpers/factory-host-launch-suite";

test("a queued attempt runs in a real Podman guest through the supervisor process and its outcome is durable", async () => {
  await expect(verifyFactoryHostLaunchEndToEnd()).resolves.toBeUndefined();
}, 300_000);
