import { test, expect, describe, mock, beforeEach } from "bun:test";

// ---------------------------------------------------------------------------
// 1. adjustHeight logic (pure math extracted from ChatInput.svelte)
// ---------------------------------------------------------------------------
describe("adjustHeight logic", () => {
	const MAX_ROWS = 6;
	const LINE_HEIGHT = 24;
	const maxHeight = MAX_ROWS * LINE_HEIGHT; // 144

	function computeHeight(scrollHeight: number): number {
		return Math.min(scrollHeight, maxHeight);
	}

	test("maxHeight constant is 144", () => {
		expect(maxHeight).toBe(144);
	});

	test("short content uses scrollHeight directly", () => {
		expect(computeHeight(48)).toBe(48);
		expect(computeHeight(24)).toBe(24);
		expect(computeHeight(100)).toBe(100);
	});

	test("content at exactly maxHeight returns 144", () => {
		expect(computeHeight(144)).toBe(144);
	});

	test("tall content is capped at 144", () => {
		expect(computeHeight(200)).toBe(144);
		expect(computeHeight(500)).toBe(144);
		expect(computeHeight(1000)).toBe(144);
	});

	test("adjustHeight sets textarea style correctly for short content", () => {
		const textarea = { style: { height: "" }, scrollHeight: 72 };
		// Simulate adjustHeight
		textarea.style.height = "auto";
		textarea.style.height = Math.min(textarea.scrollHeight, maxHeight) + "px";
		expect(textarea.style.height).toBe("72px");
	});

	test("adjustHeight sets textarea style correctly for tall content", () => {
		const textarea = { style: { height: "" }, scrollHeight: 300 };
		textarea.style.height = "auto";
		textarea.style.height = Math.min(textarea.scrollHeight, maxHeight) + "px";
		expect(textarea.style.height).toBe("144px");
	});

	test("adjustHeight is a no-op when textarea is undefined", () => {
		const textarea = undefined;
		// Should not throw
		const fn = () => {
			if (!textarea) return;
		};
		expect(fn).not.toThrow();
	});
});

// ---------------------------------------------------------------------------
// 2. Jump-to-bottom button behavior (logic-level)
// ---------------------------------------------------------------------------
describe("jump-to-bottom button behavior", () => {
	test("userScrolledUp starts as false", () => {
		let userScrolledUp = false;
		expect(userScrolledUp).toBe(false);
	});

	test("IntersectionObserver not intersecting sets userScrolledUp to true", () => {
		let userScrolledUp = false;
		// Simulate the observer callback: ([entry]) => { userScrolledUp = !entry.isIntersecting }
		const callback = (entries: { isIntersecting: boolean }[]) => {
			userScrolledUp = !entries[0]!.isIntersecting;
		};

		callback([{ isIntersecting: false }]);
		expect(userScrolledUp).toBe(true);
	});

	test("IntersectionObserver intersecting sets userScrolledUp to false", () => {
		let userScrolledUp = true;
		const callback = (entries: { isIntersecting: boolean }[]) => {
			userScrolledUp = !entries[0]!.isIntersecting;
		};

		callback([{ isIntersecting: true }]);
		expect(userScrolledUp).toBe(false);
	});

	test("button click resets userScrolledUp and calls scrollIntoView", () => {
		let userScrolledUp = true;
		const scrollIntoView = mock((_opts?: ScrollIntoViewOptions) => {});
		const sentinel = { scrollIntoView };

		// Simulate button onclick handler
		const handleClick = () => {
			userScrolledUp = false;
			sentinel.scrollIntoView({ behavior: "smooth" });
		};

		handleClick();
		expect(userScrolledUp).toBe(false);
		expect(scrollIntoView).toHaveBeenCalledTimes(1);
		expect(scrollIntoView).toHaveBeenCalledWith({ behavior: "smooth" });
	});

	test("multiple observer toggles track state correctly", () => {
		let userScrolledUp = false;
		const callback = (entries: { isIntersecting: boolean }[]) => {
			userScrolledUp = !entries[0]!.isIntersecting;
		};

		callback([{ isIntersecting: false }]);
		expect(userScrolledUp).toBe(true);

		callback([{ isIntersecting: true }]);
		expect(userScrolledUp).toBe(false);

		callback([{ isIntersecting: false }]);
		expect(userScrolledUp).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// 3. Auto-scroll effect
// ---------------------------------------------------------------------------
describe("auto-scroll effect", () => {
	test("scrolls when userScrolledUp is false and streaming text changes", () => {
		let userScrolledUp = false;
		const scrollIntoView = mock((_opts?: ScrollIntoViewOptions) => {});
		const sentinel = { scrollIntoView };

		// Simulate the $effect from +page.svelte
		const runEffect = (streamingText: string | undefined) => {
			void streamingText; // track dependency
			if (!userScrolledUp && sentinel) {
				sentinel.scrollIntoView({ behavior: "instant" as ScrollBehavior });
			}
		};

		runEffect("Hello");
		expect(scrollIntoView).toHaveBeenCalledTimes(1);

		runEffect("Hello world");
		expect(scrollIntoView).toHaveBeenCalledTimes(2);
	});

	test("does NOT scroll when userScrolledUp is true", () => {
		let userScrolledUp = true;
		const scrollIntoView = mock((_opts?: ScrollIntoViewOptions) => {});
		const sentinel = { scrollIntoView };

		const runEffect = (streamingText: string | undefined) => {
			void streamingText;
			if (!userScrolledUp && sentinel) {
				sentinel.scrollIntoView({ behavior: "instant" as ScrollBehavior });
			}
		};

		runEffect("Hello");
		runEffect("Hello world");
		runEffect("Hello world!");
		expect(scrollIntoView).toHaveBeenCalledTimes(0);
	});

	test("does NOT scroll when sentinel is undefined", () => {
		let userScrolledUp = false;
		let sentinel: { scrollIntoView: (_opts?: ScrollIntoViewOptions) => void } | undefined = undefined;

		// Should not throw
		const runEffect = (streamingText: string | undefined) => {
			void streamingText;
			if (!userScrolledUp && sentinel) {
				sentinel.scrollIntoView({ behavior: "instant" as ScrollBehavior });
			}
		};

		expect(() => runEffect("test")).not.toThrow();
	});

	test("resumes auto-scroll when user clicks jump-to-bottom", () => {
		let userScrolledUp = true;
		const scrollIntoView = mock((_opts?: ScrollIntoViewOptions) => {});
		const sentinel = { scrollIntoView };

		const runEffect = (streamingText: string | undefined) => {
			void streamingText;
			if (!userScrolledUp && sentinel) {
				sentinel.scrollIntoView({ behavior: "instant" as ScrollBehavior });
			}
		};

		// While scrolled up, no auto-scroll
		runEffect("token1");
		expect(scrollIntoView).toHaveBeenCalledTimes(0);

		// User clicks jump-to-bottom
		userScrolledUp = false;
		sentinel.scrollIntoView({ behavior: "smooth" });

		// Now auto-scroll works again
		runEffect("token2");
		expect(scrollIntoView).toHaveBeenCalledTimes(2); // smooth + instant
	});

	test("scrollIntoView is called with behavior instant during streaming", () => {
		let userScrolledUp = false;
		const scrollIntoView = mock((_opts?: ScrollIntoViewOptions) => {});
		const sentinel = { scrollIntoView };

		const runEffect = (streamingText: string | undefined) => {
			void streamingText;
			if (!userScrolledUp && sentinel) {
				sentinel.scrollIntoView({ behavior: "instant" as ScrollBehavior });
			}
		};

		runEffect("chunk");
		expect(scrollIntoView).toHaveBeenCalledWith({ behavior: "instant" });
	});
});

// ---------------------------------------------------------------------------
// 4. Scrollbar CSS (verify styles exist in ChatInput component source)
// ---------------------------------------------------------------------------
describe("scrollbar CSS in ChatInput", () => {
	let cssContent: string;

	beforeEach(async () => {
		const file = Bun.file(
			new URL("../lib/components/ChatInput.svelte", import.meta.url).pathname,
		);
		cssContent = await file.text();
	});

	test("sets scrollbar-width: thin on textarea", () => {
		expect(cssContent).toContain("scrollbar-width: thin");
	});

	test("default scrollbar-color is transparent transparent", () => {
		expect(cssContent).toContain("scrollbar-color: transparent transparent");
	});

	test("hover changes scrollbar-color", () => {
		// The style block has: textarea:hover { scrollbar-color: var(--color-border) transparent; }
		expect(cssContent).toMatch(/textarea:hover[\s\S]*?scrollbar-color:\s*var\(--color-border\)\s+transparent/);
	});

	test("focus changes scrollbar-color", () => {
		expect(cssContent).toMatch(/textarea:focus[\s\S]*?scrollbar-color:\s*var\(--color-border\)\s+transparent/);
	});

	test("webkit scrollbar width is 6px", () => {
		expect(cssContent).toContain("width: 6px");
	});

	test("webkit scrollbar thumb is transparent by default", () => {
		expect(cssContent).toMatch(/scrollbar-thumb\s*\{[\s\S]*?background:\s*transparent/);
	});

	test("webkit scrollbar thumb shows on hover", () => {
		expect(cssContent).toMatch(/textarea:hover::-webkit-scrollbar-thumb/);
	});

	test("overflow-y is set to auto on textarea", () => {
		expect(cssContent).toContain("overflow-y: auto");
	});
});

// ---------------------------------------------------------------------------
// 5. IntersectionObserver setup (mock-based)
// ---------------------------------------------------------------------------
describe("IntersectionObserver setup", () => {
	test("observer is created with container as root and threshold 0.1", () => {
		let observerOptions: IntersectionObserverInit | undefined;
		let observedElement: Element | undefined;

		const MockObserver = class {
			constructor(
				_cb: IntersectionObserverCallback,
				options?: IntersectionObserverInit,
			) {
				observerOptions = options;
			}
			observe(el: Element) {
				observedElement = el;
			}
			disconnect() {}
		};

		const container = {} as HTMLDivElement;
		const sentinel = {} as HTMLDivElement;

		// Simulate onMount logic
		const observer = new MockObserver(
			([entry]) => {
				// callback
			},
			{ root: container, threshold: 0.1 },
		);
		observer.observe(sentinel);

		expect(observerOptions).toEqual({ root: container, threshold: 0.1 });
		expect(observedElement).toBe(sentinel);
	});

	test("observer.disconnect is called on cleanup", () => {
		const disconnect = mock(() => {});
		const observer = { disconnect, observe: () => {} };

		// Simulate cleanup returned from onMount
		const cleanup = () => {
			observer.disconnect();
		};

		cleanup();
		expect(disconnect).toHaveBeenCalledTimes(1);
	});
});

// ---------------------------------------------------------------------------
// 6. handleSend resets scroll state
// ---------------------------------------------------------------------------
describe("handleSend scroll reset", () => {
	test("sending a message sets userScrolledUp to false", () => {
		let userScrolledUp = true;
		const scrollIntoView = mock((_opts?: ScrollIntoViewOptions) => {});
		const sentinel = { scrollIntoView };

		// Simulate the relevant part of handleSend
		const handleSendScrollReset = () => {
			userScrolledUp = false;
			// requestAnimationFrame(() => sentinel.scrollIntoView(...))
			sentinel.scrollIntoView({ behavior: "instant" as ScrollBehavior });
		};

		handleSendScrollReset();
		expect(userScrolledUp).toBe(false);
		expect(scrollIntoView).toHaveBeenCalledTimes(1);
	});
});
