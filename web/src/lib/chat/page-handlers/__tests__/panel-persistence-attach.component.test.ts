import { render } from "@testing-library/svelte";
import { beforeEach, describe, expect, test, vi } from "vitest";

const { readPanels, writePanels } = vi.hoisted(() => ({ readPanels: vi.fn(), writePanels: vi.fn() }));
vi.mock("$lib/panel-persistence.js", () => ({ readChatPanels: readPanels, writeChatPanels: writePanels }));
const Harness = (await import("./PanelPersistenceHarness.svelte")).default;

beforeEach(() => {
	readPanels.mockReset();
	writePanels.mockReset();
});

describe("attachPanelPersistence", () => {
	test("restores then persists through real Svelte effects", async () => {
		readPanels.mockReturnValue({
			obsOpen: true, diffPanelOpen: false, toolsOpen: false, settingsOpen: false,
			taskLogsOpen: false, taskLogsTaskId: null, selectedAgentSubConvId: null,
		});
		const { getByTestId } = render(Harness);
		await Promise.resolve();
		await Promise.resolve();
		expect(getByTestId("obs")).toHaveTextContent("open");
		expect(readPanels).toHaveBeenCalledWith("conv-1");
		expect(writePanels).toHaveBeenCalledWith("conv-1", expect.objectContaining({ obsOpen: true }));
	});
});
