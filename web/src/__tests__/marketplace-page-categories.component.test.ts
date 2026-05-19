/**
 * Phase 49.3 — Marketplace page tag-sidebar integration test.
 *
 * Renders `/marketplace/+page.svelte`, mocks the API surface, and
 * asserts:
 *   - Sidebar populates from `fetchMarketplaceCategories()`.
 *   - Clicking a chip selects it visually + re-calls
 *     `browseMarketplace({ tag })`.
 *   - Clicking the same chip again deselects (toggle).
 *   - Empty taxonomy → "No tags yet." copy.
 *   - "All" chip clears the active tag.
 */

import "@testing-library/jest-dom/vitest";
import { render, fireEvent, waitFor } from "@testing-library/svelte";
import { describe, test, expect, vi, beforeEach } from "vitest";

const {
  browseMarketplaceMock,
  fetchMarketplaceCategoriesMock,
  importManifestMock,
} = vi.hoisted(() => ({
  browseMarketplaceMock: vi.fn(),
  fetchMarketplaceCategoriesMock: vi.fn(),
  importManifestMock: vi.fn(),
}));

vi.mock("$app/navigation", () => ({ goto: vi.fn() }));

vi.mock("$lib/api.js", () => ({
  browseMarketplace: (...args: unknown[]) => browseMarketplaceMock(...args),
  fetchMarketplaceCategories: (...args: unknown[]) =>
    fetchMarketplaceCategoriesMock(...args),
  importManifest: (...args: unknown[]) => importManifestMock(...args),
}));

import MarketplacePage from "../routes/(app)/marketplace/+page.svelte";

beforeEach(() => {
  browseMarketplaceMock.mockReset().mockResolvedValue({
    listings: [],
    featured: [],
  });
  fetchMarketplaceCategoriesMock.mockReset();
  importManifestMock.mockReset();
});

describe("/marketplace — Phase 49.3 tag sidebar", () => {
  test("sidebar renders chips from fetchMarketplaceCategories()", async () => {
    fetchMarketplaceCategoriesMock.mockResolvedValue({
      categories: [
        { tag: "research", count: 7 },
        { tag: "writing", count: 3 },
      ],
    });
    const { findAllByTestId, findByTestId } = render(MarketplacePage);
    await findByTestId("marketplace-tag-sidebar");
    const chips = await findAllByTestId("marketplace-tag-chip");
    expect(chips.length).toBe(2);
    expect(chips[0]!.textContent).toContain("research");
    expect(chips[0]!.textContent).toContain("7");
    expect(chips[1]!.textContent).toContain("writing");
    expect(chips[1]!.textContent).toContain("3");
  });

  test("clicking a chip filters listings via tag query", async () => {
    fetchMarketplaceCategoriesMock.mockResolvedValue({
      categories: [{ tag: "research", count: 7 }],
    });
    const { findAllByTestId } = render(MarketplacePage);
    const [chip] = await findAllByTestId("marketplace-tag-chip");
    // Initial mount call — no tag.
    await waitFor(() => expect(browseMarketplaceMock).toHaveBeenCalled());
    const initialCall = browseMarketplaceMock.mock.calls[0]![0] as {
      tag?: string;
    };
    expect(initialCall.tag).toBeUndefined();

    await fireEvent.click(chip!);
    await waitFor(() => {
      const last = browseMarketplaceMock.mock.calls.at(-1)![0] as {
        tag?: string;
      };
      expect(last.tag).toBe("research");
    });
    expect(chip!.getAttribute("aria-pressed")).toBe("true");
  });

  test("clicking the same chip again deselects (toggle)", async () => {
    fetchMarketplaceCategoriesMock.mockResolvedValue({
      categories: [{ tag: "research", count: 7 }],
    });
    const { findAllByTestId } = render(MarketplacePage);
    const [chip] = await findAllByTestId("marketplace-tag-chip");
    await fireEvent.click(chip!);
    await waitFor(() => {
      const last = browseMarketplaceMock.mock.calls.at(-1)![0] as {
        tag?: string;
      };
      expect(last.tag).toBe("research");
    });
    // Second click → unselect → tag undefined.
    await fireEvent.click(chip!);
    await waitFor(() => {
      const last = browseMarketplaceMock.mock.calls.at(-1)![0] as {
        tag?: string;
      };
      expect(last.tag).toBeUndefined();
    });
    expect(chip!.getAttribute("aria-pressed")).toBe("false");
  });

  test("'All' chip clears the active tag", async () => {
    fetchMarketplaceCategoriesMock.mockResolvedValue({
      categories: [{ tag: "research", count: 7 }],
    });
    const { findAllByTestId, findByTestId } = render(MarketplacePage);
    const [chip] = await findAllByTestId("marketplace-tag-chip");
    await fireEvent.click(chip!);
    await waitFor(() => {
      const last = browseMarketplaceMock.mock.calls.at(-1)![0] as {
        tag?: string;
      };
      expect(last.tag).toBe("research");
    });

    const allChip = await findByTestId("marketplace-tag-all");
    await fireEvent.click(allChip);
    await waitFor(() => {
      const last = browseMarketplaceMock.mock.calls.at(-1)![0] as {
        tag?: string;
      };
      expect(last.tag).toBeUndefined();
    });
  });

  test("empty taxonomy → 'No tags yet.' copy", async () => {
    fetchMarketplaceCategoriesMock.mockResolvedValue({ categories: [] });
    const { findByText } = render(MarketplacePage);
    expect(await findByText("No tags yet.")).toBeInTheDocument();
  });

  test("typing search while a tag is active sends both q and tag in the same browseMarketplace call", async () => {
    // Pin: search box debounce + active tag must coalesce into a single
    // call carrying { q, tag }. Backend `marketplace-queries-deep.test.ts`
    // covers `q` and `tag` independently — this asserts the combined case
    // at the page-component level.
    fetchMarketplaceCategoriesMock.mockResolvedValue({
      categories: [{ tag: "research", count: 7 }],
    });
    const { findAllByTestId, findByPlaceholderText } = render(MarketplacePage);
    const [chip] = await findAllByTestId("marketplace-tag-chip");

    // Activate the tag first.
    await fireEvent.click(chip!);
    await waitFor(() => {
      const last = browseMarketplaceMock.mock.calls.at(-1)![0] as {
        tag?: string;
      };
      expect(last.tag).toBe("research");
    });

    // Now type into the search box. The page debounces (300ms) before
    // calling browseMarketplace; wait for the debounce to flush.
    const searchInput = (await findByPlaceholderText(
      "Search agents...",
    )) as HTMLInputElement;
    await fireEvent.input(searchInput, { target: { value: "foo" } });

    await waitFor(
      () => {
        const last = browseMarketplaceMock.mock.calls.at(-1)![0] as {
          q?: string;
          tag?: string;
        };
        expect(last.q).toBe("foo");
        expect(last.tag).toBe("research");
      },
      { timeout: 1000 },
    );
  });

  test("fetchMarketplaceCategories failure is non-fatal (page still renders)", async () => {
    fetchMarketplaceCategoriesMock.mockRejectedValue(new Error("boom"));
    const { findByTestId, findByText } = render(MarketplacePage);
    // Sidebar still renders, just empty.
    await findByTestId("marketplace-tag-sidebar");
    expect(await findByText("No tags yet.")).toBeInTheDocument();
  });
});
