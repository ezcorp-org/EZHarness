import { describe, expect, test } from "bun:test";
import { runStage2Proof, stage2Enabled } from "./helpers/stage2-proof";

describe.skipIf(!stage2Enabled)("Stage 2 IPv6 isolation", () => {
  test("the launcher removes seeded IPv6 while IPv4 proxy traffic works; omitting only the disable writes fails", () => {
    const protectedState = runStage2Proof("--ipv6-on", 0);
    expect(protectedState).toMatchObject({
      faultDisableCommandsRemoved: [],
      ipv6: { eth0Disable: "1", loDisable: "1", eth0HasSeed: false, loHasSeed: false, routeExit: 2 },
    });
    expect(protectedState.ipv6?.routeStderr).toMatch(/network is unreachable/i);
    const fault = runStage2Proof("--ipv6-off", 51, "IPV6_ASSERTION_FAILED");
    expect(fault).toMatchObject({
      faultDisableCommandsRemoved: ["eth0.disable_ipv6", "lo.disable_ipv6"],
      ipv6: { eth0Disable: "0", loDisable: "0", eth0HasSeed: true, loHasSeed: true, routeExit: 0 },
    });
  }, 70_000);
});
