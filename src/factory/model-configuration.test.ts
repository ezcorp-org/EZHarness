import { describe, expect, test } from "bun:test";
import { FactoryModelConfigurationError, factoryModelSamplingOptions } from "./model-configuration";

describe("a model pin's configuration", () => {
  test("maps each supported key to exactly one request field", () => {
    expect(factoryModelSamplingOptions({ temperature: 0, seed: 42, reasoningEffort: "none" }))
      .toEqual({ temperature: 0, samplingParams: { seed: 42, reasoning_effort: "none" } });
    expect(factoryModelSamplingOptions({ temperature: 1.5 })).toEqual({ temperature: 1.5 });
    expect(factoryModelSamplingOptions({ seed: 0 })).toEqual({ samplingParams: { seed: 0 } });
    for (const effort of ["low", "medium", "high"]) expect(factoryModelSamplingOptions({ reasoningEffort: effort })).toEqual({ samplingParams: { reasoning_effort: effort } });
  });

  test("an empty configuration adds nothing to the request", () => {
    expect(factoryModelSamplingOptions({})).toEqual({});
  });

  test("the answer is frozen, so a caller cannot widen what the pin said", () => {
    const options = factoryModelSamplingOptions({ temperature: 0, seed: 1 });
    expect(Object.isFrozen(options)).toBe(true);
    expect(Object.isFrozen(options.samplingParams)).toBe(true);
  });

  test("an unknown key, or a known key with a value it cannot carry, is refused by name", () => {
    const refusal = (configuration: Record<string, unknown>) => {
      try { factoryModelSamplingOptions(configuration); }
      catch (error) { return error; }
      throw new Error("expected a refusal");
    };
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ topK: 4 }, "topK"],
      [{ temperature: -0.1 }, "temperature"],
      [{ temperature: 2.5 }, "temperature"],
      [{ temperature: Number.NaN }, "temperature"],
      [{ temperature: "0" }, "temperature"],
      [{ seed: 1.5 }, "seed"],
      [{ seed: Number.MAX_SAFE_INTEGER + 1 }, "seed"],
      [{ reasoningEffort: "maximum" }, "reasoningEffort"],
      [{ temperature: 0, samplingParams: { seed: 1 } }, "samplingParams"],
    ];
    for (const [configuration, key] of cases) {
      const error = refusal(configuration);
      expect(error).toBeInstanceOf(FactoryModelConfigurationError);
      expect(error).toMatchObject({ code: "factory_model_configuration_unsupported", key, name: "FactoryModelConfigurationError", message: `factory_model_configuration_unsupported: ${key}` });
    }
  });
});
