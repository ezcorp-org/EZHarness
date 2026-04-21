import { describe, test, expect, mock, beforeEach } from "bun:test";

/**
 * Integration tests for ChatInput's keyboard delegation logic.
 * Tests the MENU_NAV_KEYS set and activeMenu routing that delegates
 * keyboard events to MentionPopover or ToolPicker.
 */

const MENU_NAV_KEYS = new Set([
  "ArrowDown",
  "ArrowUp",
  "Enter",
  "Tab",
  "Escape",
]);

interface MockMenu {
  handleKeydown: (e: { key: string }) => void;
  calls: string[];
}

function createMockMenu(): MockMenu {
  const calls: string[] = [];
  return {
    handleKeydown: mock((e: { key: string }) => {
      calls.push(e.key);
    }),
    calls,
  };
}

/**
 * Mirrors the activeMenu selection logic from ChatInput.handleKeydown:
 *   const activeMenu = mentionOpen ? popoverRef : showToolPicker ? toolPickerRef : null;
 */
function getActiveMenu(
  mentionOpen: boolean,
  popoverRef: MockMenu | null,
  showToolPicker: boolean,
  toolPickerRef: MockMenu | null,
): MockMenu | null {
  return mentionOpen ? popoverRef : showToolPicker ? toolPickerRef : null;
}

describe("MENU_NAV_KEYS set", () => {
  test("contains all navigation keys", () => {
    expect(MENU_NAV_KEYS.has("ArrowDown")).toBe(true);
    expect(MENU_NAV_KEYS.has("ArrowUp")).toBe(true);
    expect(MENU_NAV_KEYS.has("Enter")).toBe(true);
    expect(MENU_NAV_KEYS.has("Tab")).toBe(true);
    expect(MENU_NAV_KEYS.has("Escape")).toBe(true);
  });

  test("does not contain non-navigation keys", () => {
    expect(MENU_NAV_KEYS.has("a")).toBe(false);
    expect(MENU_NAV_KEYS.has("Backspace")).toBe(false);
    expect(MENU_NAV_KEYS.has("Space")).toBe(false);
    expect(MENU_NAV_KEYS.has("Shift")).toBe(false);
    expect(MENU_NAV_KEYS.has("Delete")).toBe(false);
  });
});

describe("activeMenu selection priority", () => {
  let popover: MockMenu;
  let toolPicker: MockMenu;

  beforeEach(() => {
    popover = createMockMenu();
    toolPicker = createMockMenu();
  });

  test("mentionOpen takes priority over showToolPicker", () => {
    const menu = getActiveMenu(true, popover, true, toolPicker);
    expect(menu).toBe(popover);
  });

  test("toolPicker selected when mentionOpen is false", () => {
    const menu = getActiveMenu(false, popover, true, toolPicker);
    expect(menu).toBe(toolPicker);
  });

  test("null when both are closed", () => {
    const menu = getActiveMenu(false, popover, false, toolPicker);
    expect(menu).toBeNull();
  });

  test("null when mentionOpen but popoverRef is null", () => {
    const menu = getActiveMenu(true, null, false, null);
    // mentionOpen is true but popoverRef is null → returns null (falsy)
    expect(menu).toBeNull();
  });

  test("null when showToolPicker but toolPickerRef is null", () => {
    const menu = getActiveMenu(false, null, true, null);
    expect(menu).toBeNull();
  });
});

describe("keyboard delegation routing", () => {
  let popover: MockMenu;
  let toolPicker: MockMenu;

  beforeEach(() => {
    popover = createMockMenu();
    toolPicker = createMockMenu();
  });

  /**
   * Simulates the delegation logic from ChatInput.handleKeydown:
   *   const activeMenu = ...;
   *   if (activeMenu && MENU_NAV_KEYS.has(e.key)) {
   *     activeMenu.handleKeydown(e);
   *     return; // prevents further handling
   *   }
   * Returns true if delegated, false if fell through.
   */
  function simulateKeydown(
    key: string,
    mentionOpen: boolean,
    showToolPicker: boolean,
  ): boolean {
    const activeMenu = getActiveMenu(
      mentionOpen,
      popover,
      showToolPicker,
      toolPicker,
    );
    if (activeMenu && MENU_NAV_KEYS.has(key)) {
      activeMenu.handleKeydown({ key });
      return true;
    }
    return false;
  }

  test("all nav keys delegate to MentionPopover when open", () => {
    for (const key of MENU_NAV_KEYS) {
      expect(simulateKeydown(key, true, false)).toBe(true);
    }
    expect(popover.handleKeydown).toHaveBeenCalledTimes(5);
    expect(popover.calls).toEqual([
      "ArrowDown",
      "ArrowUp",
      "Enter",
      "Tab",
      "Escape",
    ]);
    expect(toolPicker.handleKeydown).not.toHaveBeenCalled();
  });

  test("all nav keys delegate to ToolPicker when open (mention closed)", () => {
    for (const key of MENU_NAV_KEYS) {
      expect(simulateKeydown(key, false, true)).toBe(true);
    }
    expect(toolPicker.handleKeydown).toHaveBeenCalledTimes(5);
    expect(toolPicker.calls).toEqual([
      "ArrowDown",
      "ArrowUp",
      "Enter",
      "Tab",
      "Escape",
    ]);
    expect(popover.handleKeydown).not.toHaveBeenCalled();
  });

  test("non-nav keys fall through even when menu is open", () => {
    expect(simulateKeydown("a", true, false)).toBe(false);
    expect(simulateKeydown("Backspace", true, false)).toBe(false);
    expect(simulateKeydown("Shift", false, true)).toBe(false);
    expect(popover.handleKeydown).not.toHaveBeenCalled();
    expect(toolPicker.handleKeydown).not.toHaveBeenCalled();
  });

  test("all keys fall through when no menu is open", () => {
    for (const key of MENU_NAV_KEYS) {
      expect(simulateKeydown(key, false, false)).toBe(false);
    }
    expect(popover.handleKeydown).not.toHaveBeenCalled();
    expect(toolPicker.handleKeydown).not.toHaveBeenCalled();
  });

  test("Tab delegates to popover (not swallowed as focus change)", () => {
    const delegated = simulateKeydown("Tab", true, false);
    expect(delegated).toBe(true);
    expect(popover.calls).toContain("Tab");
  });

  test("Tab delegates to toolPicker (not swallowed as focus change)", () => {
    const delegated = simulateKeydown("Tab", false, true);
    expect(delegated).toBe(true);
    expect(toolPicker.calls).toContain("Tab");
  });

  test("Enter delegates to menu instead of submitting form", () => {
    const delegated = simulateKeydown("Enter", true, false);
    expect(delegated).toBe(true);
    expect(popover.calls).toContain("Enter");
  });
});
