import { mock } from "bun:test";
import * as runtime from "../runtime";

const runtimeExports = { ...runtime };

export function restoreModuleMocks(): void {
  mock.restore();
  mock.module("@ezcorp/sdk/runtime", () => runtimeExports);
}
