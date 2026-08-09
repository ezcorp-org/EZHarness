/**
 * DOM tests for RoutingExperimentsSection — the two routing experiments on
 * /settings/models (`provider:explorationRate`, `provider:routingShadow`).
 *
 * Coverage:
 *   1. both experiments are OFF out of the box, and say so
 *   2. exploration states its quality cost, and raising it requires ticking
 *      the acknowledgement — the save stays disabled until then
 *   3. the rate box is a PERCENTAGE: 5 → 0.05 on the wire, 100 reads as
 *      "every routed turn", 150 is refused in percent units
 *   4. turning exploration off needs no acknowledgement
 *   5. shadow: an inverted pair is refused inline with the SERVER's sentence,
 *      half a pair asks for the other half, a good pair saves
 *   6. clearing shadow mode DELETEs the key (absence is its off state)
 *   7. every failed write rolls the optimistic mutation back and shows the
 *      route's own message
 */
import { describe, test, expect, vi, afterEach } from "vitest";
import { render, fireEvent, waitFor } from "@testing-library/svelte";
import RoutingExperimentsSection from "../settings/RoutingExperimentsSection.svelte";
import type { TierThresholds } from "$server/runtime/tier-classifier";

interface FetchCall {
  url: string;
  method: string;
  body?: unknown;
}
let calls: FetchCall[] = [];

/** The shape the write route answers a rejected edit with. */
function rejection(message: string): Response {
  return new Response(JSON.stringify({ error: message }), { status: 400 });
}

function stubFetch(opts: { reject?: string; rejectMethod?: string } = {}) {
  calls = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      calls.push({
        url: String(input),
        method,
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      });
      if (opts.reject && (opts.rejectMethod ?? method) === method) return rejection(opts.reject);
      return Response.json({ ok: true });
    }),
  );
}

afterEach(() => vi.unstubAllGlobals());

const writes = () => calls.filter((c) => c.method !== "GET");

function mount(props: { explorationRate?: number; shadowThresholds?: TierThresholds } = {}) {
  return render(RoutingExperimentsSection, {
    props: {
      explorationRate: props.explorationRate ?? 0,
      shadowThresholds: props.shadowThresholds,
    },
  });
}

/** Type into a number box the way the browser does — value then `input`. */
async function typeNumber(el: HTMLElement, value: string) {
  await fireEvent.input(el, { target: { value } });
}

describe("RoutingExperimentsSection — bounded exploration", () => {
  test("is off out of the box, and says nothing is downgraded", () => {
    stubFetch();
    const { getByTestId, queryByTestId } = mount();

    expect(getByTestId("exploration-current")).toHaveTextContent("exploration is off");
    expect(getByTestId("exploration-impact")).toHaveTextContent(
      "Off — every routed turn is served the tier the classifier picked.",
    );
    // Nothing to turn off, nothing to acknowledge, nothing to save.
    expect(queryByTestId("exploration-off")).toBeNull();
    expect(queryByTestId("exploration-ack")).toBeNull();
    expect(getByTestId("exploration-save")).toBeDisabled();
  });

  test("states the quality cost above the control, not behind it", () => {
    stubFetch();
    const { getByText, getByTestId } = mount();
    expect(getByText("This trades answer quality for data.")).toBeInTheDocument();
    // And the box says what unit it is in, since a bare probability is how
    // the "100 meaning one percent" typo happens.
    expect(getByTestId("exploration-editor")).toHaveTextContent("% of routed turns");
    expect(getByTestId("exploration-editor")).toHaveTextContent("A percentage, not a probability");
  });

  test("raising the rate is blocked until the cost is acknowledged", async () => {
    stubFetch();
    const { getByTestId, queryByTestId } = mount();

    await typeNumber(getByTestId("exploration-rate-input"), "5");

    // The rate is described in turns, not probabilities.
    expect(getByTestId("exploration-impact")).toHaveTextContent("About 1 in 20 routed turns");
    expect(getByTestId("exploration-impact")).toHaveTextContent(
      "Some of those answers will be worse",
    );
    // …and cannot be saved on the strength of the number alone.
    expect(getByTestId("exploration-save")).toBeDisabled();

    await fireEvent.click(getByTestId("exploration-ack"));
    expect(getByTestId("exploration-save")).toBeEnabled();

    await fireEvent.click(getByTestId("exploration-save"));
    await waitFor(() => expect(writes()).toHaveLength(1));
    expect(writes()[0]!.method).toBe("PUT");
    expect(decodeURIComponent(writes()[0]!.url)).toContain(
      "/api/settings/provider:explorationRate",
    );
    // 5% on screen is 0.05 in the row.
    expect(writes()[0]!.body).toEqual({ value: 0.05 });
    expect(getByTestId("exploration-current")).toHaveTextContent("exploring 5% of routed turns");
    expect(getByTestId("save-indicator-saved")).toBeInTheDocument();
    // The next increase has to be acknowledged again.
    expect(queryByTestId("exploration-ack")).toBeNull();
  });

  test("100 in the box is every turn — loudly — rather than a silent 1%", async () => {
    stubFetch();
    const { getByTestId } = mount();
    await typeNumber(getByTestId("exploration-rate-input"), "100");
    const impact = getByTestId("exploration-impact");
    expect(impact).toHaveTextContent("Every routed turn will be answered one tier BELOW");
    expect(impact.className).toContain("font-semibold");
  });

  test("a rate past the high-water mark reads louder than a sampling rate", async () => {
    stubFetch();
    const { getByTestId } = mount();
    await typeNumber(getByTestId("exploration-rate-input"), "50");
    expect(getByTestId("exploration-impact").className).toContain("font-semibold");
    await typeNumber(getByTestId("exploration-rate-input"), "5");
    // Still tinted as a warning, just not shouted.
    expect(getByTestId("exploration-impact").className).toContain("bg-amber-500/10");
    expect(getByTestId("exploration-impact").className).not.toContain("font-semibold");
  });

  test("an out-of-range percentage is refused in percent units, before any write", async () => {
    stubFetch();
    const { getByTestId } = mount({ explorationRate: 0.05 });

    await typeNumber(getByTestId("exploration-rate-input"), "150");

    expect(getByTestId("exploration-error")).toHaveTextContent(
      "150% is not a share of traffic — enter 0 to 100",
    );
    expect(getByTestId("exploration-save")).toBeDisabled();
    // The impact line keeps describing what is actually running.
    expect(getByTestId("exploration-impact")).toHaveTextContent("About 1 in 20 routed turns");
    expect(writes()).toHaveLength(0);
  });

  test("turning exploration off takes one click and no acknowledgement", async () => {
    stubFetch();
    const { getByTestId } = mount({ explorationRate: 0.05 });
    expect(getByTestId("exploration-current")).toHaveTextContent("exploring 5% of routed turns");

    await fireEvent.click(getByTestId("exploration-off"));

    await waitFor(() => expect(writes()).toHaveLength(1));
    expect(writes()[0]!.body).toEqual({ value: 0 });
    expect(getByTestId("exploration-current")).toHaveTextContent("exploration is off");
    // The box follows the row it just wrote.
    await waitFor(() =>
      expect((getByTestId("exploration-rate-input") as HTMLInputElement).value).toBe(""),
    );
  });

  test("a rejected rate shows the route's own message and rolls back", async () => {
    stubFetch({ reject: "Invalid provider:explorationRate: 5 is not a probability" });
    const { getByTestId } = mount();

    await typeNumber(getByTestId("exploration-rate-input"), "5");
    await fireEvent.click(getByTestId("exploration-ack"));
    await fireEvent.click(getByTestId("exploration-save"));

    await waitFor(() => expect(writes()).toHaveLength(1));
    await waitFor(() =>
      expect(getByTestId("routing-experiments-save-error")).toHaveTextContent(
        "Invalid provider:explorationRate: 5 is not a probability",
      ),
    );
    // Nothing landed, so the editor is back to what the row still holds.
    await waitFor(() => {
      expect(getByTestId("exploration-current")).toHaveTextContent("exploration is off");
      expect((getByTestId("exploration-rate-input") as HTMLInputElement).value).toBe("");
    });
  });
});

describe("RoutingExperimentsSection — shadow mode", () => {
  const CANDIDATE: TierThresholds = { fastMaxTokens: 250, powerfulMinTokens: 4000 };

  test("is off out of the box, and shows the sweep → shadow → promote loop", () => {
    stubFetch();
    const { getByTestId, queryByTestId } = mount();

    expect(getByTestId("shadow-current")).toHaveTextContent("shadow mode is off");
    expect(getByTestId("shadow-workflow")).toHaveTextContent("bun run scripts/routing-sweep.ts");
    expect(getByTestId("shadow-workflow")).toHaveTextContent("Shadow Agreement");
    expect(getByTestId("shadow-editor")).toHaveTextContent("It never serves a turn");
    expect(queryByTestId("shadow-off")).toBeNull();
    expect(getByTestId("shadow-save")).toBeDisabled();
  });

  test("an inverted pair is refused inline, in the write route's own words", async () => {
    stubFetch();
    const { getByTestId } = mount();

    await typeNumber(getByTestId("shadow-fast-input"), "5000");
    await typeNumber(getByTestId("shadow-powerful-input"), "400");

    expect(getByTestId("shadow-error")).toHaveTextContent(
      "fastMaxTokens (5000) must be BELOW powerfulMinTokens (400)",
    );
    expect(getByTestId("shadow-save")).toBeDisabled();
    expect(writes()).toHaveLength(0);
  });

  test("half a pair asks for the other half instead of blaming one box", async () => {
    stubFetch();
    const { getByTestId } = mount();
    await typeNumber(getByTestId("shadow-fast-input"), "250");
    expect(getByTestId("shadow-error")).toHaveTextContent(
      "Set both thresholds, or clear both to turn shadow mode off.",
    );
    expect(getByTestId("shadow-save")).toBeDisabled();
  });

  test("a good candidate saves the pair and starts shadowing", async () => {
    stubFetch();
    const { getByTestId, queryByTestId } = mount();

    await typeNumber(getByTestId("shadow-fast-input"), "250");
    await typeNumber(getByTestId("shadow-powerful-input"), "4000");
    expect(queryByTestId("shadow-error")).toBeNull();
    await fireEvent.click(getByTestId("shadow-save"));

    await waitFor(() => expect(writes()).toHaveLength(1));
    expect(writes()[0]!.method).toBe("PUT");
    expect(decodeURIComponent(writes()[0]!.url)).toContain("/api/settings/provider:routingShadow");
    expect(writes()[0]!.body).toEqual({ value: CANDIDATE });
    expect(getByTestId("shadow-current")).toHaveTextContent("shadowing 250 / 4000 tokens");
    // Saving the same pair twice would rewrite the row with itself.
    expect(getByTestId("shadow-save")).toBeDisabled();
  });

  test("clearing the candidate DELETEs the key — absence is its off state", async () => {
    stubFetch();
    const { getByTestId } = mount({ shadowThresholds: CANDIDATE });
    expect(getByTestId("shadow-current")).toHaveTextContent("shadowing 250 / 4000 tokens");

    await fireEvent.click(getByTestId("shadow-off"));

    await waitFor(() => expect(writes()).toHaveLength(1));
    expect(writes()[0]!.method).toBe("DELETE");
    expect(decodeURIComponent(writes()[0]!.url)).toContain("/api/settings/provider:routingShadow");
    expect(getByTestId("shadow-current")).toHaveTextContent("shadow mode is off");
    await waitFor(() =>
      expect((getByTestId("shadow-fast-input") as HTMLInputElement).value).toBe(""),
    );
  });

  test("a rejected save rolls the candidate back", async () => {
    stubFetch({ reject: "Invalid provider:routingShadow: nope", rejectMethod: "PUT" });
    const { getByTestId } = mount();

    await typeNumber(getByTestId("shadow-fast-input"), "250");
    await typeNumber(getByTestId("shadow-powerful-input"), "4000");
    await fireEvent.click(getByTestId("shadow-save"));

    await waitFor(() =>
      expect(getByTestId("routing-experiments-save-error")).toHaveTextContent(
        "Invalid provider:routingShadow: nope",
      ),
    );
    await waitFor(() => {
      expect(getByTestId("shadow-current")).toHaveTextContent("shadow mode is off");
      expect((getByTestId("shadow-fast-input") as HTMLInputElement).value).toBe("");
    });
  });

  test("a failed clear leaves the candidate running", async () => {
    stubFetch({ reject: "Not found", rejectMethod: "DELETE" });
    const { getByTestId } = mount({ shadowThresholds: CANDIDATE });

    await fireEvent.click(getByTestId("shadow-off"));

    await waitFor(() =>
      expect(getByTestId("routing-experiments-save-error")).toHaveTextContent("Not found"),
    );
    await waitFor(() => {
      expect(getByTestId("shadow-current")).toHaveTextContent("shadowing 250 / 4000 tokens");
      expect((getByTestId("shadow-fast-input") as HTMLInputElement).value).toBe("250");
    });
  });
});
