import { describe, expect, test } from "bun:test";

import {
  parseReferenceImageLock,
  REFERENCE_IMAGE_LOCK_SCHEMA_VERSION,
  ReferenceImageLockError,
  referenceImageLock,
  referenceImageLockDigest,
  referenceImageModelPins,
  sdxlClosureDirectory,
  sdxlWeightUrl,
} from "./lock.ts";

/** A deep, mutable copy of the committed lock, for building one-field defects. */
function mutable(): Record<string, any> {
  return JSON.parse(JSON.stringify(referenceImageLock)) as Record<string, any>;
}

function expectRefusal(mutate: (lock: Record<string, any>) => void, matching?: RegExp): void {
  const lock = mutable();
  mutate(lock);
  let thrown: unknown;
  try {
    parseReferenceImageLock(lock);
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(ReferenceImageLockError);
  expect((thrown as ReferenceImageLockError).code).toBe("reference_image_lock_invalid");
  if (matching !== undefined) expect((thrown as Error).message).toMatch(matching);
}

describe("the committed lock", () => {
  test("it parses and names the image pack", () => {
    expect(referenceImageLock.schemaVersion).toBe(REFERENCE_IMAGE_LOCK_SCHEMA_VERSION);
    expect(referenceImageLock.definitionId).toBe("reference.image.v1");
  });

  test("it pins exactly the C10 settings", () => {
    expect(referenceImageLock.generation.seeds).toEqual([11, 23, 37, 53]);
    expect(referenceImageLock.generation.inferenceSteps).toBe(30);
    expect(referenceImageLock.generation.guidanceScale).toBe(7.5);
    expect(referenceImageLock.generation.width).toBe(1024);
    expect(referenceImageLock.generation.height).toBe(1024);
  });

  test("it pins the contract's model and pipeline", () => {
    expect(referenceImageLock.model.repository).toBe("stabilityai/stable-diffusion-xl-base-1.0");
    expect(referenceImageLock.model.pipeline).toBe("StableDiffusionXLPipeline");
    expect(referenceImageLock.model.revision).toMatch(/^[a-f0-9]{40}$/);
  });

  test("it pins the C10 byte and OCR thresholds", () => {
    expect(referenceImageLock.normalization.maximumBytes).toBe(10 * 1024 * 1024);
    expect(referenceImageLock.normalization.colorMode).toBe("RGB");
    expect(referenceImageLock.ocr.minimumWordConfidence).toBe(60);
    expect(referenceImageLock.ocr.language).toBe("eng");
  });

  test("it pins the evaluation model, fields, and quorum", () => {
    expect(referenceImageLock.evaluation.model).toBe("claude-haiku-4-5-20251001");
    expect(referenceImageLock.evaluation.fields).toEqual(["oneOakTree", "greenFoliage", "plainWhiteBackground", "noText"]);
    expect(referenceImageLock.evaluation.evaluations).toBe(3);
    expect(referenceImageLock.evaluation.minimumPasses).toBe(2);
    expect(referenceImageLock.evaluation.requireAllDecisive).toBe(true);
  });

  test("it pins both the base image and the built guest image by digest", () => {
    expect(referenceImageLock.runtime.baseImage).toMatch(/@sha256:[a-f0-9]{64}$/);
    expect(referenceImageLock.runtime.guestImage).toMatch(/@sha256:[a-f0-9]{64}$/);
  });

  test("it records every weight file with a digest and every small file with a blob identifier", () => {
    const weights = referenceImageLock.model.files.filter(file => file.digest !== undefined);
    expect(weights.length).toBeGreaterThan(0);
    for (const file of referenceImageLock.model.files) {
      expect(file.blobId).toMatch(/^[a-f0-9]{40}$/);
      expect(file.bytes).toBeGreaterThan(0);
      if (file.digest !== undefined) expect(file.digest).toMatch(/^sha256:[a-f0-9]{64}$/);
    }
  });

  test("the model files are sorted, so the digest measures content rather than order", () => {
    const names = referenceImageLock.model.files.map(file => file.path);
    expect([...names].sort()).toEqual(names);
  });

  test("it is deeply frozen, so a caller cannot edit the pin it just read", () => {
    expect(Object.isFrozen(referenceImageLock)).toBe(true);
    expect(Object.isFrozen(referenceImageLock.generation.seeds)).toBe(true);
    expect(Object.isFrozen(referenceImageLock.model.files[0])).toBe(true);
  });
});

describe("the lock digest", () => {
  test("it is stable across reads", () => {
    expect(referenceImageLockDigest()).toBe(referenceImageLockDigest());
  });

  test("changing a seed changes it", () => {
    const changed = mutable();
    changed.generation.seeds = [11, 23, 37, 59];
    expect(referenceImageLockDigest(parseReferenceImageLock(changed))).not.toBe(referenceImageLockDigest());
  });

  test("changing the OCR threshold changes it", () => {
    const changed = mutable();
    changed.ocr.minimumWordConfidence = 61;
    expect(referenceImageLockDigest(parseReferenceImageLock(changed))).not.toBe(referenceImageLockDigest());
  });

  test("changing one weight digest changes it", () => {
    const changed = mutable();
    const weight = changed.model.files.find((file: { digest?: string }) => file.digest !== undefined);
    weight.digest = `sha256:${"b".repeat(64)}`;
    expect(referenceImageLockDigest(parseReferenceImageLock(changed))).not.toBe(referenceImageLockDigest());
  });

  test("reordering the keys of a document does not change it", () => {
    const original = JSON.parse(JSON.stringify(referenceImageLock)) as Record<string, unknown>;
    const reordered = Object.fromEntries(Object.entries(original).reverse());
    expect(Object.keys(reordered)).not.toEqual(Object.keys(original));
    expect(referenceImageLockDigest(parseReferenceImageLock(reordered))).toBe(referenceImageLockDigest());
  });
});

describe("what the lock refuses", () => {
  test("a different schema version", () => expectRefusal(lock => { lock.schemaVersion = "factory.reference-image-lock.v2"; }, /schema/));
  test("a different definition", () => expectRefusal(lock => { lock.definitionId = "reference.code.v1"; }, /reference\.image\.v1/));
  test("a model source that is not HTTPS", () => expectRefusal(lock => { lock.model.source = "http://huggingface.co"; }, /HTTPS/));
  test("a revision that is a branch name rather than a commit", () => expectRefusal(lock => { lock.model.revision = "main"; }, /commit/));
  test("an unpinned base image", () => expectRefusal(lock => { lock.runtime.baseImage = "docker.io/rocm/pytorch:latest"; }, /base image/));
  test("an unpinned guest image", () => expectRefusal(lock => { lock.runtime.guestImage = "localhost/ezcorp-reference-image:latest"; }, /guest image/));
  test("an empty distribution list", () => expectRefusal(lock => { lock.runtime.distributions = []; }, /distributions/));
  test("a distribution without a version", () => expectRefusal(lock => { lock.runtime.distributions = ["torch"]; }, /name==version/));
  test("an unsorted distribution list", () => expectRefusal(lock => { lock.runtime.distributions = ["zzz==1", "aaa==1"]; }, /sorted/));
  test("an interpreter that is not an exact version", () => expectRefusal(lock => { lock.runtime.pythonVersion = "3.13"; }, /exact interpreter/));
  test("a model file list that is empty", () => expectRefusal(lock => { lock.model.files = []; }, /list its files/));
  test("a model file path that escapes the closure", () => expectRefusal(lock => { lock.model.files[0].path = "../escape"; }, /inside the closure/));
  test("an unsorted model file list", () => expectRefusal(lock => { lock.model.files = [lock.model.files[1], lock.model.files[0]]; }, /sorted and unique/));
  test("a model file with no blob identifier", () => expectRefusal(lock => { lock.model.files[0].blobId = "short"; }, /blob identifier/));
  test("a malformed weight digest", () => expectRefusal(lock => {
    const weight = lock.model.files.find((file: { digest?: string }) => file.digest !== undefined);
    weight.digest = "sha256:short";
  }, /malformed digest/));
  test("a closure with no weight pinned by digest", () => expectRefusal(lock => {
    for (const file of lock.model.files) delete file.digest;
  }, /at least one weight/));
  test("a seed that is negative", () => expectRefusal(lock => { lock.generation.seeds = [-1, 23, 37, 53]; }, /nonnegative/));
  test("seeds recorded out of order", () => expectRefusal(lock => { lock.generation.seeds = [53, 37, 23, 11]; }, /ascending input order/));
  test("a duplicated seed", () => expectRefusal(lock => { lock.generation.seeds = [11, 11, 37, 53]; }, /ascending input order/));
  test("a zero inference step count", () => expectRefusal(lock => { lock.generation.inferenceSteps = 0; }, /inferenceSteps/));
  test("a guidance scale of zero", () => expectRefusal(lock => { lock.generation.guidanceScale = 0; }, /guidance scale/));
  test("a normalization that is not PNG", () => expectRefusal(lock => { lock.normalization.format = "JPEG"; }, /PNG/));
  test("a colour mode outside RGB and RGBA", () => expectRefusal(lock => { lock.normalization.colorMode = "grayscale"; }, /RGB or RGBA/));
  test("a bit depth other than eight", () => expectRefusal(lock => { lock.normalization.bitDepth = 16; }, /eight-bit/));
  test("a normalization that keeps ancillary chunks", () => expectRefusal(lock => { lock.normalization.stripAncillaryChunks = false; }, /strip ancillary/));
  test("an allowed-chunk list missing a critical chunk", () => expectRefusal(lock => { lock.normalization.allowedChunks = ["IHDR", "IDAT"]; }, /IEND/));
  test("a chunk type that is not four letters", () => expectRefusal(lock => { lock.normalization.allowedChunks = ["IHDR", "IDAT", "IEND", "ab"]; }, /four-letter/));
  test("a compression level outside zero to nine", () => expectRefusal(lock => { lock.normalization.compressLevel = 10; }, /compression level/));
  test("a language that is not three letters", () => expectRefusal(lock => { lock.ocr.language = "english"; }, /three-letter/));
  test("a confidence threshold above one hundred", () => expectRefusal(lock => { lock.ocr.minimumWordConfidence = 101; }, /confidence threshold/));
  test("an evaluation quorum larger than the number of evaluations", () => expectRefusal(lock => { lock.evaluation.minimumPasses = 4; }, /cannot exceed/));
  test("a quorum that does not require every evaluation to be decisive", () => expectRefusal(lock => { lock.evaluation.requireAllDecisive = false; }, /decisive/));
  test("a duplicated evaluation field", () => expectRefusal(lock => { lock.evaluation.fields = ["noText", "noText", "greenFoliage", "oneOakTree"]; }, /unique/));
  test("a negative temperature", () => expectRefusal(lock => { lock.evaluation.temperature = -1; }, /temperature/));
  test("a document that is not an object", () => {
    expect(() => parseReferenceImageLock("a lock")).toThrow(ReferenceImageLockError);
    expect(() => parseReferenceImageLock(null)).toThrow(ReferenceImageLockError);
  });
});

describe("resolving the closure", () => {
  test("a weight URL names the pinned revision, never a branch", () => {
    const url = sdxlWeightUrl("unet/diffusion_pytorch_model.fp16.safetensors");
    expect(url).toContain(`/resolve/${referenceImageLock.model.revision}/`);
    expect(url).not.toContain("/main/");
  });

  test("a file the lock does not declare has no URL", () => {
    expect(() => sdxlWeightUrl("unet/secret.safetensors")).toThrow(/does not declare/);
  });

  test("the closure directory carries the revision, so two revisions cannot share bytes", () => {
    expect(sdxlClosureDirectory()).toEndWith(`/${referenceImageLock.model.revision}`);
  });

  test("the model pins are sorted and name every weight by digest", () => {
    const pins = referenceImageModelPins();
    expect(pins.length).toBe(referenceImageLock.model.files.filter(file => file.digest !== undefined).length);
    expect([...pins].sort()).toEqual([...pins]);
    for (const pin of pins) expect(pin).toMatch(/^stabilityai\/stable-diffusion-xl-base-1\.0\/.+@sha256:[a-f0-9]{64}$/);
  });
});
