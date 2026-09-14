import { describe, expect, test } from "bun:test";
import {
  FACTORY_RELEASE_SEAMS,
  FactorySeamUnavailableError,
  factoryReleaseSeamsPresent,
  factoryRuntimeSeams,
  factorySeam,
  factorySeamStates,
} from "./runtime-seams";

describe("factorySeam", () => {
  test("an absent collaborator refuses by name instead of answering", () => {
    const seam = factorySeam("physical-stopper", "W03");
    expect(seam.present).toBe(false);
    expect(seam.optional()).toBeUndefined();
    try {
      seam.require();
      throw new Error("the seam answered");
    } catch (error) {
      expect(error).toBeInstanceOf(FactorySeamUnavailableError);
      const refusal = error as FactorySeamUnavailableError;
      expect(refusal.code).toBe("factory_seam_unavailable");
      expect(refusal.seam).toBe("physical-stopper");
      expect(refusal.workPackage).toBe("W03");
      // The operator must be able to go from the refusal to the package.
      expect(refusal.message).toContain("W03");
    }
  });

  test("a present collaborator is returned unchanged by both accessors", () => {
    const collaborator = { step: async () => true };
    const seam = factorySeam("physical-stopper", "W03", collaborator);
    expect(seam.present).toBe(true);
    expect(seam.require()).toBe(collaborator);
    expect(seam.optional()).toBe(collaborator);
  });

  test("refuses a seam that cannot name itself or its owner", () => {
    expect(() => factorySeam("Physical", "W03")).toThrow(/lowercase dashed identifier/);
    expect(() => factorySeam("x", "W03")).toThrow(/lowercase dashed identifier/);
    expect(() => factorySeam("physical-stopper", "team-sol")).toThrow(/owning work package/);
    expect(() => factorySeam("physical-stopper", "")).toThrow(/owning work package/);
    expect(factorySeam("archive-writer", "W04a").workPackage).toBe("W04a");
    expect(factorySeam("release-providers", "W07/W08").workPackage).toBe("W07/W08");
  });
});

describe("factoryRuntimeSeams", () => {
  test("names every collaborator W09 does not own, and its package", () => {
    const seams = factoryRuntimeSeams();
    expect(factorySeamStates(seams)).toEqual([
      { seam: "physical-stopper", workPackage: "W03", present: false },
      { seam: "usage-reconciler", workPackage: "W03", present: false },
      { seam: "child-settlement", workPackage: "W06", present: false },
      { seam: "release-providers", workPackage: "W07/W08", present: false },
      { seam: "notification-sender", workPackage: "W17", present: false },
      { seam: "validator-gateway", workPackage: "W05", present: false },
      { seam: "release-fence-reader", workPackage: "W05", present: false },
      { seam: "current-candidate", workPackage: "W05", present: false },
      { seam: "destination-reservations", workPackage: "W07/W08", present: false },
      { seam: "sender-fence", workPackage: "W07/W08", present: false },
    ]);
  });

  test("marks only the collaborators that were supplied as present", () => {
    const seams = factoryRuntimeSeams({ physicalStopper: { step: async () => true }, notificationSender: { step: async () => false } });
    expect(seams.physicalStopper.present).toBe(true);
    expect(seams.notificationSender.present).toBe(true);
    expect(seams.usageReconciler.present).toBe(false);
    expect(() => seams.usageReconciler.require()).toThrow(FactorySeamUnavailableError);
    expect(factorySeamStates(seams).filter((state) => state.present).map((state) => state.seam))
      .toEqual(["physical-stopper", "notification-sender"]);
  });
});

describe("factoryReleaseSeamsPresent", () => {
  test("requires all five release collaborators, not a subset", () => {
    expect(factoryReleaseSeamsPresent(factoryRuntimeSeams())).toBe(false);
    const complete: Record<string, unknown> = {};
    for (const key of FACTORY_RELEASE_SEAMS) {
      complete[key] = { supplied: key };
      const partial = factoryRuntimeSeams(complete);
      const expected = key === FACTORY_RELEASE_SEAMS.at(-1);
      expect(factoryReleaseSeamsPresent(partial)).toBe(expected);
    }
  });

  test("a supplied non-release seam does not make the release store composable", () => {
    const drivers = { physicalStopper: { step: async () => false }, usageReconciler: { step: async () => false }, notificationSender: { step: async () => false } };
    expect(factoryReleaseSeamsPresent(factoryRuntimeSeams(drivers))).toBe(false);
  });
});
