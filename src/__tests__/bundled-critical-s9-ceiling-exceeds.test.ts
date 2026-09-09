// Current immutable lifecycle regression coverage retained at the original suite path.
import { expect, test } from "bun:test";
import { LifecycleError, actor, harness, releaseFixture, approved } from "./helpers/durable-lifecycle-fixture";

test("a revoked permission between candidate startup and commit blocks activation", async () => {
    let denied = false;
    const setup = await releaseFixture(harness({ async authorize(_actor, action) { if (action === "activate" && denied) throw new LifecycleError("permission_revoked", "Permission revoked."); } }));
    const input = await approved(setup);
    setup.dependencies.verifyCandidate = async () => { denied = true; };
    const result = await setup.lifecycle.activate(actor, input);
    expect(result.state).toBe("failed");
    expect((await setup.lifecycle.inspect(actor, setup.installation.id)).installation.activeReleaseId).toBeNull();
  });
