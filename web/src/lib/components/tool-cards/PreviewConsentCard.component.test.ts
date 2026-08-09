/**
 * PreviewConsentCard component tests (vitest + jsdom, run from web/).
 *
 * Secure User-Site Preview / Port Exposure, Phase 2 (§3.3).
 *
 * Covers: renders the three affordances exactly once (no double-render);
 * Expose → POST /api/preview/consent then shows the Open-preview link;
 * Always-expose posts action=always-expose; Ignore is a non-action (shows
 * Ignored, fires a best-effort POST, no link); a failed expose surfaces
 * the error banner + Try-again restores the prompt.
 */
import { render, fireEvent, cleanup, waitFor } from "@testing-library/svelte";
import { describe, test, expect, afterEach, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import PreviewConsentCard from "./PreviewConsentCard.svelte";
import type { PreviewConsentCardData } from "./preview-consent-card-logic.js";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const DATA: PreviewConsentCardData = {
  conversationId: "conv-1",
  port: 5173,
  title: "A site started on port 5173",
  summary: "Expose it to your browser? Nothing is served until you choose.",
};

function stubFetch(impl: (url: string, init?: RequestInit) => Promise<Response>) {
  const spy = vi.fn(impl);
  vi.stubGlobal("fetch", spy);
  return spy;
}

describe("PreviewConsentCard", () => {
  test("renders all three affordances exactly once (no double-render)", () => {
    const { getAllByTestId, getByTestId } = render(PreviewConsentCard, { props: { data: DATA } });
    expect(getAllByTestId("preview-consent-card")).toHaveLength(1);
    expect(getByTestId("preview-consent-expose")).toBeInTheDocument();
    expect(getByTestId("preview-consent-ignore")).toBeInTheDocument();
    expect(getByTestId("preview-consent-always")).toBeInTheDocument();
  });

  test("Expose posts action=expose then renders the Open-preview link", async () => {
    const spy = stubFetch(
      async () =>
        new Response(JSON.stringify({ ok: true, subdomainLabel: "abc26label", code: "code123" }), {
          status: 200,
        }),
    );
    const { getByTestId } = render(PreviewConsentCard, { props: { data: DATA } });
    await fireEvent.click(getByTestId("preview-consent-expose"));

    await waitFor(() => expect(getByTestId("preview-consent-open")).toBeInTheDocument());
    const body = JSON.parse((spy.mock.calls[0]![1] as RequestInit).body as string);
    expect(body).toEqual({ conversationId: "conv-1", port: 5173, action: "expose" });
    const href = getByTestId("preview-consent-open").getAttribute("href") ?? "";
    expect(href).toContain("abc26label.preview.");
    expect(href).toContain("/__open?c=code123");
  });

  test("Always-expose posts action=always-expose", async () => {
    const spy = stubFetch(
      async () =>
        new Response(JSON.stringify({ ok: true, subdomainLabel: "lbl", code: "c" }), {
          status: 200,
        }),
    );
    const { getByTestId } = render(PreviewConsentCard, { props: { data: DATA } });
    await fireEvent.click(getByTestId("preview-consent-always"));
    await waitFor(() => expect(getByTestId("preview-consent-open")).toBeInTheDocument());
    const body = JSON.parse((spy.mock.calls[0]![1] as RequestInit).body as string);
    expect(body.action).toBe("always-expose");
  });

  test("Ignore is a non-action: shows Ignored, no preview link", async () => {
    const spy = stubFetch(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
    const { getByTestId, queryByTestId } = render(PreviewConsentCard, { props: { data: DATA } });
    await fireEvent.click(getByTestId("preview-consent-ignore"));
    await waitFor(() => expect(getByTestId("preview-consent-ignored")).toBeInTheDocument());
    expect(queryByTestId("preview-consent-open")).toBeNull();
    // Best-effort audit POST still fired with action=ignore.
    const body = JSON.parse((spy.mock.calls[0]![1] as RequestInit).body as string);
    expect(body.action).toBe("ignore");
  });

  test("a failed expose surfaces the error banner + Try-again restores the prompt", async () => {
    stubFetch(async () => new Response(JSON.stringify({ error: "boom" }), { status: 500 }));
    const { getByTestId, getByText } = render(PreviewConsentCard, { props: { data: DATA } });
    await fireEvent.click(getByTestId("preview-consent-expose"));
    await waitFor(() => expect(getByTestId("preview-consent-error")).toHaveTextContent("boom"));
    await fireEvent.click(getByText("Try again"));
    expect(getByTestId("preview-consent-expose")).toBeInTheDocument();
  });
});
