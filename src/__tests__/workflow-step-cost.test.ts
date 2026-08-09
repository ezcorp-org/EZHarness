/**
 * `stepCostUsd` — the composition that turns a step row's
 * provider/model/tokens into the `cost_usd` column.
 *
 * The property this file exists to protect: **NULL and "0.000000" are
 * different answers.** NULL says a cost could not be measured (no LLM ran,
 * no usage reported, or the model is unpriced); "0.000000" says it was
 * measured and was free. Collapsing them either way makes `SUM(cost_usd)`
 * lie — in one direction it invents spend that never happened, in the
 * other it erases a real measurement. The value is advisory (display and
 * analysis); that is precisely why it has to be honest, since no
 * enforcement path will ever catch it being wrong.
 *
 * Rates are INJECTED rather than read from the live catalog for the
 * arithmetic cases, so a pi-ai price change cannot turn a correctness test
 * red. One case deliberately uses the real default lookup, because the
 * wiring to `modelPrices` is itself part of what is under test.
 */
import { test, expect, describe } from "bun:test";
import { stepCostUsd, STEP_COST_SCALE, type PriceLookup } from "../runtime/workflow-step-cost";

/** $3/1M input, $15/1M output — the shape of a real priced model. */
const PRICED: PriceLookup = () => ({
  input: 3,
  output: 15,
  cacheRead: 0.3,
  cacheWrite: 3.75,
});

/** An all-zero rate table: exactly how an OAuth-subscription model
 *  arrives, since it is rate-limited rather than billed per token. */
const UNPRICED: PriceLookup = () => ({
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
});

describe("a cost is only produced when one could be measured", () => {
  test("a priced model with reported tokens yields a fixed-point cost", () => {
    // 1_000_000 input @ $3/1M = $3; 1_000_000 output @ $15/1M = $15.
    const cost = stepCostUsd(
      { provider: "anthropic", model: "m", inputTokens: 1_000_000, outputTokens: 1_000_000 },
      PRICED,
    );
    expect(cost).toBe("18.000000");
  });

  test("the string carries the column's full scale, not a float", () => {
    const cost = stepCostUsd(
      { provider: "anthropic", model: "m", inputTokens: 1, outputTokens: 0 },
      PRICED,
    );
    // 1 token @ $3/1M = $0.000003 — a value a 2dp format would erase.
    expect(cost).toBe("0.000003");
    expect(cost?.split(".")[1]).toHaveLength(STEP_COST_SCALE);
  });

  test("an unpriced model yields null, NOT a zero cost", () => {
    // THE row this file exists for. An OAuth-subscription model has no
    // per-token price at all, so "$0.00" would be a fabricated
    // measurement. A reader seeing 0 would believe the step was free;
    // seeing NULL it knows the step was never priceable.
    const cost = stepCostUsd(
      { provider: "openai-codex", model: "m", inputTokens: 5000, outputTokens: 900 },
      UNPRICED,
    );
    expect(cost).toBeNull();
    expect(cost).not.toBe("0.000000");
  });

  test("a PRICED model that consumed zero tokens yields a real zero", () => {
    // The other side of the same coin, and why the unpriced case cannot
    // simply be "0". Here the measurement happened and the answer was
    // zero — that zero is data, and it must survive.
    const cost = stepCostUsd(
      { provider: "anthropic", model: "m", inputTokens: 0, outputTokens: 0 },
      PRICED,
    );
    expect(cost).toBe("0.000000");
    expect(cost).not.toBeNull();
  });

  test("no reported tokens at all yields null — a tool/transform/gate step", () => {
    // These steps run no LLM. Their real-world cost is not zero, it is
    // unmeasured — and a `tool` step is exactly the kind that reaches an
    // external side effect with a real bill. Pricing them as 0 would let
    // `SUM(cost_usd)` read as total spend when it is only LLM spend.
    expect(stepCostUsd({ provider: "anthropic", model: "m" }, PRICED)).toBeNull();
    expect(
      stepCostUsd(
        { provider: "anthropic", model: "m", inputTokens: null, outputTokens: null },
        PRICED,
      ),
    ).toBeNull();
  });

  test("one counter reported and one absent still prices, treating the absent as zero", () => {
    // A partial report is still a report. Refusing to price it would
    // discard a real measurement; treating the missing side as zero is
    // the only reading that does not invent tokens.
    expect(stepCostUsd({ provider: "anthropic", model: "m", inputTokens: 1_000_000 }, PRICED)).toBe(
      "3.000000",
    );
    expect(
      stepCostUsd({ provider: "anthropic", model: "m", outputTokens: 1_000_000 }, PRICED),
    ).toBe("15.000000");
  });

  test("an unresolved provider or model yields null — the 'running' write", () => {
    // The first write for a step happens before the agent has resolved
    // anything, so there is no binding to look a price up with.
    expect(stepCostUsd({ model: "m", inputTokens: 10, outputTokens: 10 }, PRICED)).toBeNull();
    expect(
      stepCostUsd({ provider: "anthropic", inputTokens: 10, outputTokens: 10 }, PRICED),
    ).toBeNull();
    expect(
      stepCostUsd({ provider: "", model: "", inputTokens: 10, outputTokens: 10 }, PRICED),
    ).toBeNull();
    expect(stepCostUsd({}, PRICED)).toBeNull();
  });

  test("a lookup that knows nothing yields null rather than throwing", () => {
    expect(
      stepCostUsd(
        { provider: "p", model: "m", inputTokens: 10, outputTokens: 10 },
        () => undefined,
      ),
    ).toBeNull();
  });
});

describe("the default lookup is the real model catalog", () => {
  // The wiring itself is a property: a helper that priced correctly but
  // was never connected to `modelPrices` would pass every test above.
  test("a real priced model resolves through the default lookup", () => {
    const cost = stepCostUsd({
      provider: "anthropic",
      model: "claude-sonnet-4-5",
      inputTokens: 1_000_000,
      outputTokens: 0,
    });
    expect(cost).not.toBeNull();
    expect(Number(cost)).toBeGreaterThan(0);
  });

  test("an unknown model resolves to unpriced, not to a fabricated zero", () => {
    // `resolveModelObject` synthesizes a fallback with all-zero rates for
    // an id the catalog has never heard of. That must read as "unpriced".
    const cost = stepCostUsd({
      provider: "not-a-real-provider",
      model: "not-a-real-model",
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
    });
    expect(cost).toBeNull();
  });
});
