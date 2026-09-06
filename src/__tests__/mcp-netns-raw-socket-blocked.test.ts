import { describe, expect, test } from "bun:test";
import { runStage2Proof, stage2Enabled } from "./helpers/stage2-proof";

// The production policy drops packets. A bounded timeout is expected; the
// nft-off control proves a reachable listener, not a refused or missing route.
describe.skipIf(!stage2Enabled)("Stage 2 direct TCP isolation", () => {
  test("the production namespace blocks direct TCP; removing only nft makes the deny assertion fail", () => {
    const protectedState = runStage2Proof("--nft-on", 0);
    expect(protectedState).toMatchObject({
      rawConnect: "TIMEOUT", acceptedConnections: 0, faultDisableCommandsRemoved: [],
    });
    const fault = runStage2Proof("--nft-off", 41, "DENY_ASSERTION_FAILED");
    expect(fault).toMatchObject({
      rawConnect: "CONNECTED", acceptedConnections: 1, faultDisableCommandsRemoved: [],
    });
  }, 70_000);
});
