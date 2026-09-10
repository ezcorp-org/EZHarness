import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { hoverTooltip } from "./hover-tooltip";

type Listener = () => void;
type Rect = { top: number; bottom: number; left: number; width: number; height: number };

const delay = () => new Promise<void>((resolve) => setTimeout(resolve, 170));

function setup({ scrollWidth = 200, clientWidth = 100, rect }: { scrollWidth?: number; clientWidth?: number; rect?: Partial<Rect> } = {}) {
  const listeners = new Map<string, Listener>();
  const remove = mock(() => {});
  const setAttribute = mock(() => {});
  const tip = {
    textContent: "",
    style: { cssText: "", top: "", left: "" },
    setAttribute,
    getBoundingClientRect: () => ({ width: 80, height: 24 }),
    remove,
  };
  const createElement = mock(() => tip);
  const appendChild = mock(() => tip);
  const node = {
    scrollWidth,
    clientWidth,
    addEventListener: (event: string, listener: Listener) => listeners.set(event, listener),
    removeEventListener: (event: string) => listeners.delete(event),
    getBoundingClientRect: () => ({ top: 50, bottom: 70, left: 20, width: 100, height: 20, ...rect }),
  } as unknown as HTMLElement;

  globalThis.document = {
    createElement,
    body: { appendChild },
  } as unknown as Document;
  globalThis.window = { innerWidth: 180 } as unknown as Window & typeof globalThis;
  return { listeners, tip, createElement, appendChild, remove, setAttribute, node };
}

beforeEach(() => {
  // Each test installs its own minimal browser surface.
});

afterEach(() => {
  // @ts-expect-error Bun has no browser document in this suite.
  delete globalThis.document;
  // @ts-expect-error Bun has no browser window in this suite.
  delete globalThis.window;
});

describe("hoverTooltip", () => {
  test("shows a clamped tooltip for truncated text, updates it, and hides it", async () => {
    const fixture = setup({ rect: { left: -30, top: 4, bottom: 24, width: 80 } });
    const action = hoverTooltip(fixture.node, "Long title");

    fixture.listeners.get("mouseenter")?.();
    await delay();

    expect(fixture.createElement).toHaveBeenCalledWith("div");
    expect(fixture.appendChild).toHaveBeenCalledWith(fixture.tip);
    expect(fixture.setAttribute).toHaveBeenCalledWith("role", "tooltip");
    expect(fixture.tip.textContent).toBe("Long title");
    expect(fixture.tip.style.cssText).toContain("position:fixed");
    expect(fixture.tip.style.top).toBe("32px");
    expect(fixture.tip.style.left).toBe("8px");

    action.update("Changed title");
    expect(fixture.tip.textContent).toBe("Changed title");
    fixture.listeners.get("mouseleave")?.();
    expect(fixture.remove).toHaveBeenCalledTimes(1);
  });

  test("does not render for empty or untruncated text and removes listeners on destroy", async () => {
    const fixture = setup({ scrollWidth: 100, clientWidth: 100 });
    const action = hoverTooltip(fixture.node, "Fits");

    fixture.listeners.get("focusin")?.();
    await delay();
    expect(fixture.createElement).not.toHaveBeenCalled();

    action.update("");
    fixture.listeners.get("mouseenter")?.();
    await delay();
    expect(fixture.createElement).not.toHaveBeenCalled();

    action.destroy();
    expect(fixture.listeners.size).toBe(0);
  });
});
