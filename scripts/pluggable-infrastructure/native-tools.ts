import { executeNativeTool } from "../../src/runtime/sandbox/native-tool-runner";

process.stdout.write(`${await executeNativeTool("/workspace", process.argv.slice(2).join(""))}\n`);
