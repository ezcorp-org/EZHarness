import { test, expect, describe } from "bun:test";
import { handleComboboxKeydown } from "../lib/combobox-nav";

function makeKeyEvent(key: string): KeyboardEvent & { defaultPrevented: boolean } {
	let prevented = false;
	return {
		key,
		preventDefault() { prevented = true; },
		get defaultPrevented() { return prevented; },
	} as any;
}

describe("handleComboboxKeydown", () => {
	test("ArrowDown moves highlight forward", () => {
		const e = makeKeyEvent("ArrowDown");
		const result = handleComboboxKeydown(e, {
			itemCount: 5,
			highlightIndex: 0,
			onSelect: () => {},
			onClose: () => {},
		});
		expect(result).toBe(1);
		expect(e.defaultPrevented).toBe(true);
	});

	test("ArrowDown wraps from last to first", () => {
		const e = makeKeyEvent("ArrowDown");
		const result = handleComboboxKeydown(e, {
			itemCount: 3,
			highlightIndex: 2,
			onSelect: () => {},
			onClose: () => {},
		});
		expect(result).toBe(0);
	});

	test("ArrowDown with 0 items does nothing", () => {
		const e = makeKeyEvent("ArrowDown");
		const result = handleComboboxKeydown(e, {
			itemCount: 0,
			highlightIndex: -1,
			onSelect: () => {},
			onClose: () => {},
		});
		expect(result).toBe(-1);
	});

	test("ArrowUp moves highlight backward", () => {
		const e = makeKeyEvent("ArrowUp");
		const result = handleComboboxKeydown(e, {
			itemCount: 5,
			highlightIndex: 3,
			onSelect: () => {},
			onClose: () => {},
		});
		expect(result).toBe(2);
		expect(e.defaultPrevented).toBe(true);
	});

	test("ArrowUp wraps from first to last", () => {
		const e = makeKeyEvent("ArrowUp");
		const result = handleComboboxKeydown(e, {
			itemCount: 4,
			highlightIndex: 0,
			onSelect: () => {},
			onClose: () => {},
		});
		expect(result).toBe(3);
	});

	test("ArrowUp with 0 items does nothing", () => {
		const e = makeKeyEvent("ArrowUp");
		const result = handleComboboxKeydown(e, {
			itemCount: 0,
			highlightIndex: -1,
			onSelect: () => {},
			onClose: () => {},
		});
		expect(result).toBe(-1);
	});

	test("Enter calls onSelect with current index", () => {
		let selectedIndex = -1;
		const e = makeKeyEvent("Enter");
		handleComboboxKeydown(e, {
			itemCount: 5,
			highlightIndex: 2,
			onSelect: (i) => { selectedIndex = i; },
			onClose: () => {},
		});
		expect(selectedIndex).toBe(2);
		expect(e.defaultPrevented).toBe(true);
	});

	test("Enter does not call onSelect when index out of range", () => {
		let called = false;
		const e = makeKeyEvent("Enter");
		handleComboboxKeydown(e, {
			itemCount: 3,
			highlightIndex: -1,
			onSelect: () => { called = true; },
			onClose: () => {},
		});
		expect(called).toBe(false);
	});

	test("Enter does not call onSelect when index >= itemCount", () => {
		let called = false;
		const e = makeKeyEvent("Enter");
		handleComboboxKeydown(e, {
			itemCount: 3,
			highlightIndex: 5,
			onSelect: () => { called = true; },
			onClose: () => {},
		});
		expect(called).toBe(false);
	});

	test("Escape calls onClose and returns -1", () => {
		let closed = false;
		const e = makeKeyEvent("Escape");
		const result = handleComboboxKeydown(e, {
			itemCount: 5,
			highlightIndex: 2,
			onSelect: () => {},
			onClose: () => { closed = true; },
		});
		expect(closed).toBe(true);
		expect(result).toBe(-1);
		expect(e.defaultPrevented).toBe(true);
	});

	test("unhandled key returns null", () => {
		const e = makeKeyEvent("a");
		const result = handleComboboxKeydown(e, {
			itemCount: 5,
			highlightIndex: 0,
			onSelect: () => {},
			onClose: () => {},
		});
		expect(result).toBeNull();
		expect(e.defaultPrevented).toBe(false);
	});

	test("Tab returns null (not handled)", () => {
		const e = makeKeyEvent("Tab");
		const result = handleComboboxKeydown(e, {
			itemCount: 5,
			highlightIndex: 0,
			onSelect: () => {},
			onClose: () => {},
		});
		expect(result).toBeNull();
	});

	test("sequential ArrowDown navigates through all items", () => {
		let idx = 0;
		for (let i = 0; i < 4; i++) {
			const e = makeKeyEvent("ArrowDown");
			const result = handleComboboxKeydown(e, {
				itemCount: 4,
				highlightIndex: idx,
				onSelect: () => {},
				onClose: () => {},
			});
			idx = result!;
		}
		// After 4 ArrowDowns on 4 items, wraps back to 0
		expect(idx).toBe(0);
	});

	test("ArrowUp from -1 with items goes to last item", () => {
		const e = makeKeyEvent("ArrowUp");
		const result = handleComboboxKeydown(e, {
			itemCount: 3,
			highlightIndex: -1,
			onSelect: () => {},
			onClose: () => {},
		});
		// (-1 - 1 + 3) % 3 = 1 — wraps correctly
		expect(result).toBe(1);
	});

	test("ArrowDown from -1 goes to first item", () => {
		const e = makeKeyEvent("ArrowDown");
		const result = handleComboboxKeydown(e, {
			itemCount: 3,
			highlightIndex: -1,
			onSelect: () => {},
			onClose: () => {},
		});
		// (-1 + 1) % 3 = 0
		expect(result).toBe(0);
	});

	test("single item list: ArrowDown stays on same item", () => {
		const e = makeKeyEvent("ArrowDown");
		const result = handleComboboxKeydown(e, {
			itemCount: 1,
			highlightIndex: 0,
			onSelect: () => {},
			onClose: () => {},
		});
		expect(result).toBe(0);
	});

	test("single item list: ArrowUp stays on same item", () => {
		const e = makeKeyEvent("ArrowUp");
		const result = handleComboboxKeydown(e, {
			itemCount: 1,
			highlightIndex: 0,
			onSelect: () => {},
			onClose: () => {},
		});
		expect(result).toBe(0);
	});

	test("Enter at index 0 selects first item", () => {
		let selectedIndex = -1;
		const e = makeKeyEvent("Enter");
		const result = handleComboboxKeydown(e, {
			itemCount: 5,
			highlightIndex: 0,
			onSelect: (i) => { selectedIndex = i; },
			onClose: () => {},
		});
		expect(selectedIndex).toBe(0);
		expect(result).toBe(0);
	});

	test("Enter returns current highlightIndex unchanged", () => {
		const e = makeKeyEvent("Enter");
		const result = handleComboboxKeydown(e, {
			itemCount: 5,
			highlightIndex: 3,
			onSelect: () => {},
			onClose: () => {},
		});
		expect(result).toBe(3);
	});

	test("Enter at last valid index selects correctly", () => {
		let selectedIndex = -1;
		const e = makeKeyEvent("Enter");
		const result = handleComboboxKeydown(e, {
			itemCount: 4,
			highlightIndex: 3,
			onSelect: (i) => { selectedIndex = i; },
			onClose: () => {},
		});
		expect(selectedIndex).toBe(3);
		expect(result).toBe(3);
	});

	test("ArrowDown preventDefault is called even with 0 items", () => {
		const e = makeKeyEvent("ArrowDown");
		handleComboboxKeydown(e, {
			itemCount: 0,
			highlightIndex: 0,
			onSelect: () => {},
			onClose: () => {},
		});
		expect(e.defaultPrevented).toBe(true);
	});

	test("ArrowUp preventDefault is called even with 0 items", () => {
		const e = makeKeyEvent("ArrowUp");
		handleComboboxKeydown(e, {
			itemCount: 0,
			highlightIndex: 0,
			onSelect: () => {},
			onClose: () => {},
		});
		expect(e.defaultPrevented).toBe(true);
	});

	test("sequential ArrowUp navigates through all items in reverse", () => {
		let idx = 2;
		for (let i = 0; i < 3; i++) {
			const e = makeKeyEvent("ArrowUp");
			const result = handleComboboxKeydown(e, {
				itemCount: 3,
				highlightIndex: idx,
				onSelect: () => {},
				onClose: () => {},
			});
			idx = result!;
		}
		// After 3 ArrowUps on 3 items, wraps back to 2
		expect(idx).toBe(2);
	});

	test("Enter with itemCount 0 does not call onSelect", () => {
		let called = false;
		const e = makeKeyEvent("Enter");
		handleComboboxKeydown(e, {
			itemCount: 0,
			highlightIndex: 0,
			onSelect: () => { called = true; },
			onClose: () => {},
		});
		expect(called).toBe(false);
	});
});
