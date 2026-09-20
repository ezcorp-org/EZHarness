import { executeNativeTool } from "../../src/runtime/sandbox/native-tool-runner";

process.stdout.write(`${await executeNativeTool("/workspace", process.argv[2] ?? "")}\n`);
