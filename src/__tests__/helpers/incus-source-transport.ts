/** Private temporary-filesystem transport fixture. Host authority remains real. */
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import type { SandboxProtocolOperation } from "@ezcorp/extension-contract";

const FILE_ACTION = `import importlib.util,json,sys
spec=importlib.util.spec_from_file_location('helper',sys.argv[1]);h=importlib.util.module_from_spec(spec);spec.loader.exec_module(h)
request=json.load(sys.stdin)
try: print(json.dumps({'ok':True,**h.file_action(sys.argv[2],request,sys.argv[3],sys.argv[4])}))
except (h.Failure,OSError) as error: print(json.dumps({'ok':False,'error':{'code':'INVALID_PATH','message':str(error)}}))
`;
interface CompletedProcess {
  processId: string;
  sandboxId: string;
  bootId: string;
  state: "succeeded" | "failed";
  startedAt: string;
  finishedAt: string;
  exitCode: number;
  signal: null;
  stdout: Buffer;
  stderr: Buffer;
  digest: string;
}

export function createIncusSourceTransport(workspace: string, stateRoot: string) {
  const processes = new Map<string, CompletedProcess>();
  const helper = resolve(import.meta.dir, "../../infrastructure/incus-guest/helper.py");
  return async (operation: SandboxProtocolOperation, input: Record<string, unknown>): Promise<unknown> => {
    if (operation.startsWith("files.")) {
      const process = Bun.spawnSync(["python3", "-c", FILE_ACTION, helper, operation.replace("files.", "file."), workspace, stateRoot],
        { stdin: Buffer.from(JSON.stringify(input)), timeout: 10_000 });
      if (process.exitCode !== 0) throw new Error("Private guest file fixture failed");
      return JSON.parse(new TextDecoder().decode(process.stdout));
    }
    if (operation === "processes.start") {
      if (!Array.isArray(input.argv) || !input.argv.every(value => typeof value === "string")
        || input.cwd !== "." || JSON.stringify(input.env) !== "[]") throw new Error("Unsupported private guest process fixture input");
      const processId = createHash("sha256").update(JSON.stringify([input.sandboxId, input.requestId, input.idempotencyKey])).digest("hex").slice(0, 32);
      const digest = createHash("sha256").update(JSON.stringify(input.argv)).digest("hex");
      const prior = processes.get(processId);
      if (prior) {
        if (prior.digest !== digest) throw new Error("Guest process identity was reused with different input");
        return { ok: true, processId, bootId: prior.bootId, startedAt: prior.startedAt };
      }
      const startedAt = new Date().toISOString();
      const result = Bun.spawnSync(input.argv, { cwd: workspace, timeout: 10_000,
        env: { PATH: process.env.PATH ?? "", HOME: workspace, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" } });
      processes.set(processId, { processId, sandboxId: String(input.sandboxId), bootId: "private-fixture-boot", startedAt,
        finishedAt: new Date().toISOString(), state: result.exitCode === 0 ? "succeeded" : "failed", exitCode: result.exitCode,
        signal: null, stdout: Buffer.from(result.stdout), stderr: Buffer.from(result.stderr), digest });
      return { ok: true, processId, bootId: "private-fixture-boot", startedAt };
    }
    const completed = processes.get(String(input.processId));
    if (!completed || input.bootId !== completed.bootId) throw new Error("Unknown private guest process identity");
    if (operation === "processes.inspect") {
      const { stdout: _stdout, stderr: _stderr, digest: _digest, ...process } = completed;
      return { ok: true, process };
    }
    if (operation === "processes.readOutput") {
      const cursor = input.cursor as Record<string, unknown>;
      let offset = Number(cursor.offsetBytes);
      let remaining = Number(input.maxBytes);
      const chunks: Array<{ stream: string; offsetBytes: number; byteLength: number; dataBase64: string }> = [];
      for (const [stream, data, start] of [["stdout", completed.stdout, 0], ["stderr", completed.stderr, completed.stdout.length]] as const) {
        const at = Math.max(0, offset - start);
        if (at >= data.length || remaining === 0) continue;
        const bytes = data.subarray(at, at + remaining);
        chunks.push({ stream, offsetBytes: offset, byteLength: bytes.length, dataBase64: bytes.toString("base64") });
        offset += bytes.length;
        remaining -= bytes.length;
      }
      return { ok: true, chunks, nextCursor: { sandboxId: input.sandboxId, processId: input.processId, bootId: input.bootId, offsetBytes: offset },
        eof: offset === completed.stdout.length + completed.stderr.length };
    }
    throw new Error("Unexpected private guest transport operation");
  };
}
