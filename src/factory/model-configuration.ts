/**
 * What a model pin's `configuration` may say, and how it reaches the provider.
 *
 * `FactoryModelPin.configuration` is digested into the pin and compared field
 * for field, so a guest cannot change it. It must also be HONOURED: a pin that
 * names temperature 0 and a seed, and a request that silently omits them, would
 * make every receipt describe a call that never happened. So each key maps to
 * exactly one request field, and a key this module does not know is refused by
 * name rather than dropped. The startup document is checked with the same
 * function, so an operator learns about an unsupported key at boot, not at the
 * first guest call.
 *
 *   temperature      the sampling temperature, 0 to 2
 *   seed             a sampling seed, sent as the OpenAI-compatible `seed`
 *   reasoningEffort  `none`, `low`, `medium` or `high`, sent as
 *                    `reasoning_effort`; `none` turns a thinking model's
 *                    reasoning phase off (measured on Ollama 0.21 with
 *                    qwen3:1.7b: with it the answer is stable across calls,
 *                    without it the reasoning text differed between two
 *                    identical seeded calls at temperature 0)
 */
export class FactoryModelConfigurationError extends Error {
  readonly code = "factory_model_configuration_unsupported";
  constructor(readonly key: string) {
    super(`factory_model_configuration_unsupported: ${key}`);
    this.name = "FactoryModelConfigurationError";
  }
}

export interface FactoryModelSamplingOptions {
  readonly temperature?: number;
  readonly samplingParams?: Readonly<Record<string, string | number>>;
}

const REASONING_EFFORTS: ReadonlySet<unknown> = new Set(["none", "low", "medium", "high"]);

/** The request options a pin's configuration names, and nothing it does not. */
export function factoryModelSamplingOptions(configuration: Readonly<Record<string, unknown>>): FactoryModelSamplingOptions {
  const samplingParams: Record<string, string | number> = {};
  let temperature: number | undefined;
  for (const [key, value] of Object.entries(configuration)) {
    if (key === "temperature" && typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 2) temperature = value;
    else if (key === "seed" && Number.isSafeInteger(value)) samplingParams.seed = value as number;
    else if (key === "reasoningEffort" && REASONING_EFFORTS.has(value)) samplingParams.reasoning_effort = value as string;
    else throw new FactoryModelConfigurationError(key);
  }
  return Object.freeze({
    ...(temperature === undefined ? {} : { temperature }),
    ...(Object.keys(samplingParams).length === 0 ? {} : { samplingParams: Object.freeze(samplingParams) }),
  });
}
