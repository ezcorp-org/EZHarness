import type { Page } from "@playwright/test";

/**
 * Click the visible part of a SwipeDrawer backdrop through normal hit testing.
 *
 * The backdrop covers the viewport, including the drawer panel. Its centre can
 * therefore be beneath the panel, where the panel deliberately stops event
 * propagation. Find an exposed horizontal segment before clicking it.
 */
export async function clickExposedSwipeDrawerBackdrop(page: Page): Promise<void> {
  const backdrop = page.getByTestId("swipe-drawer-backdrop");
  const panel = page.getByTestId("swipe-drawer-panel");
  const [backdropBox, panelBox] = await Promise.all([
    backdrop.boundingBox(),
    panel.boundingBox(),
  ]);

  if (!backdropBox || !panelBox) {
    throw new Error("SwipeDrawer backdrop and panel must have visible bounds");
  }

  const panelLeft = panelBox.x - backdropBox.x;
  const panelRight = panelLeft + panelBox.width;
  const inset = 8;
  const clickX = panelRight < backdropBox.width
    ? Math.max(panelRight + inset, backdropBox.width - inset)
    : Math.min(panelLeft - inset, inset);
  const clickY = backdropBox.height / 2;

  if (clickX < 0 || clickX >= backdropBox.width) {
    throw new Error("SwipeDrawer panel leaves no exposed backdrop to click");
  }

  const targetTestId = await page.evaluate(
    ({ x, y }) => document.elementFromPoint(x, y)?.getAttribute("data-testid"),
    { x: backdropBox.x + clickX, y: backdropBox.y + clickY },
  );
  if (targetTestId !== "swipe-drawer-backdrop") {
    throw new Error(`Expected exposed SwipeDrawer backdrop, found ${targetTestId ?? "nothing"}`);
  }

  await backdrop.click({ position: { x: clickX, y: clickY } });
}
