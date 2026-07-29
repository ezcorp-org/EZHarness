// ── step_io record helpers — bounding, sink, key family ─────────────

import { test, expect, describe } from "bun:test";
import { emptyRepoConfig } from "./repo-config";
import {
  boundText,
  buildStepIORecord,
  emptyOutcomeFlags,
  enforceRecordCap,
  makeStepIOSink,
  snapshotRepoConfig,
  stepIOKey,
  stepIOPrefix,
  PROMPT_CAP,
  RESULT_PREVIEW_CAP,
  SHELL_OUTPUT_CAP,
  RECORD_CAP,
  type RawStepIORecord,
  type StepIODispatch,
  type StepIOShellCommand,
} from "./step-io";

const utf8 = (s: string): number => Buffer.byteLength(s, "utf-8");
const serialized = (v: unknown): number => Buffer.byteLength(JSON.stringify(v), "utf-8");

describe("key family", () => {
  test("stepIOKey / stepIOPrefix namespace per run/step/round", () => {
    expect(stepIOKey("run_1", "review", 3)).toBe("step_io/run_1/review/3");
    expect(stepIOPrefix("run_1", "review")).toBe("step_io/run_1/review/");
    // The key sits under the prefix (loader lists the prefix).
    expect(stepIOKey("run_1", "review", 3).startsWith(stepIOPrefix("run_1", "review"))).toBe(true);
  });
});

describe("boundText", () => {
  test("returns the input unchanged under the cap", () => {
    expect(boundText("hello", 1000)).toBe("hello");
    expect(boundText("", 1000)).toBe("");
  });

  test("middle-truncates with a byte-count marker, staying within the cap", () => {
    const input = "x".repeat(100_000);
    const out = boundText(input, 1000);
    expect(utf8(out)).toBeLessThanOrEqual(1000);
    expect(out).toContain("…[truncated ");
    expect(out).toContain(" bytes]");
    // Keeps a head and a tail slice of the original content.
    expect(out.startsWith("x")).toBe(true);
    expect(out.endsWith("x")).toBe(true);
  });

  test("the marker reports the number of bytes actually removed", () => {
    const input = "a".repeat(5000);
    const out = boundText(input, 1000);
    const match = out.match(/…\[truncated (\d+) bytes\]/);
    expect(match).not.toBeNull();
    const removed = Number(match![1]);
    // removed = original − kept content bytes; kept content = out minus the marker.
    const markerBytes = utf8(`…[truncated ${removed} bytes]`);
    const keptContent = utf8(out) - markerBytes;
    expect(removed).toBe(5000 - keptContent);
  });

  test("handles a cap smaller than the marker (keep clamps to 0)", () => {
    const out = boundText("a".repeat(1000), 4);
    // Never throws; result is essentially just the marker.
    expect(out).toContain("truncated");
  });
});

describe("snapshotRepoConfig", () => {
  test("projects the executing-relevant fields only", () => {
    const rc = {
      ...emptyRepoConfig(),
      agent: "claude",
      allowRepoCommands: true,
      disableProjectSettings: true,
      commands: { ...emptyRepoConfig().commands, test: "bun test", lint: "biome check" },
    };
    expect(snapshotRepoConfig(rc)).toEqual({
      agent: "claude",
      allowRepoCommands: true,
      disableProjectSettings: true,
      commandTest: "bun test",
      commandLint: "biome check",
    });
  });
});

describe("emptyOutcomeFlags", () => {
  test("all flags false (the shape recorded when a round throws)", () => {
    expect(emptyOutcomeFlags()).toEqual({
      needsApproval: false,
      autoFixable: false,
      skipped: false,
      skipRemaining: false,
      checksPassed: false,
    });
  });
});

/** A minimal raw record with overridable dispatches/shell commands. */
function rawRecord(over: Partial<RawStepIORecord> = {}): RawStepIORecord {
  return {
    runId: "run_1",
    step: "review",
    round: 1,
    trigger: "initial",
    branch: "feat/x",
    headSha: "abc1234",
    worktreePath: "/wt/run_1",
    repoConfig: snapshotRepoConfig(emptyRepoConfig()),
    startedAt: "2026-07-21T00:00:00.000Z",
    dispatches: [],
    shellCommands: [],
    endedAt: "2026-07-21T00:00:05.000Z",
    durationMs: 5000,
    error: null,
    outcome: emptyOutcomeFlags(),
    ...over,
  };
}

function dispatch(over: Partial<StepIODispatch> = {}): StepIODispatch {
  return {
    role: "reviewer",
    promptText: "review this change",
    resultPreview: "looks fine",
    assignmentId: "a1",
    subConversationId: "sc1",
    agentRunId: "ar1",
    at: "2026-07-21T00:00:01.000Z",
    ...over,
  };
}

function shell(over: Partial<StepIOShellCommand> = {}): StepIOShellCommand {
  return { command: "bun test", exitCode: 0, output: "ok", durationMs: 10, ...over };
}

describe("buildStepIORecord field caps", () => {
  test("caps prompt, shell output, and result preview, marking each", () => {
    const record = buildStepIORecord(
      rawRecord({
        dispatches: [
          dispatch({ promptText: "p".repeat(PROMPT_CAP * 2), resultPreview: "r".repeat(RESULT_PREVIEW_CAP * 2) }),
        ],
        shellCommands: [shell({ output: "s".repeat(SHELL_OUTPUT_CAP * 2) })],
      }),
    );
    const d = record.dispatches[0]!;
    expect(utf8(d.promptText)).toBeLessThanOrEqual(PROMPT_CAP);
    expect(d.promptText).toContain("truncated");
    expect(utf8(d.resultPreview)).toBeLessThanOrEqual(RESULT_PREVIEW_CAP);
    expect(utf8(record.shellCommands[0]!.output)).toBeLessThanOrEqual(SHELL_OUTPUT_CAP);
  });

  test("caps a dispatch error string and leaves absent errors absent", () => {
    const withErr = buildStepIORecord(
      rawRecord({ dispatches: [dispatch({ error: "e".repeat(RESULT_PREVIEW_CAP * 2) })] }),
    );
    expect(utf8(withErr.dispatches[0]!.error!)).toBeLessThanOrEqual(RESULT_PREVIEW_CAP);
    const noErr = buildStepIORecord(rawRecord({ dispatches: [dispatch()] }));
    expect("error" in noErr.dispatches[0]!).toBe(false);
  });

  test("small records pass through untouched", () => {
    const raw = rawRecord({ dispatches: [dispatch()], shellCommands: [shell()] });
    const record = buildStepIORecord(raw);
    expect(record.dispatches[0]!.promptText).toBe("review this change");
    expect(record.shellCommands[0]!.output).toBe("ok");
  });
});

describe("enforceRecordCap (final whole-record guard)", () => {
  test("a record that stays over cap after per-field caps is shrunk below it", () => {
    // 20 shell commands each at the 32 KB cap = ~640 KB > 256 KB even after
    // per-field capping — the whole-record guard must shrink them.
    const shellCommands = Array.from({ length: 20 }, () => shell({ output: "s".repeat(SHELL_OUTPUT_CAP) }));
    const record = buildStepIORecord(rawRecord({ shellCommands }));
    expect(serialized(record)).toBeLessThanOrEqual(RECORD_CAP);
    // And comfortably under the SDK 1 MB storage throw — the whole point.
    expect(serialized(record)).toBeLessThan(1024 * 1024);
  });

  test("shrinks the LARGEST field first (prompt vs shell vs preview)", () => {
    const record: RawStepIORecord = rawRecord({
      dispatches: [dispatch({ promptText: "p".repeat(PROMPT_CAP), resultPreview: "r".repeat(RESULT_PREVIEW_CAP) })],
      shellCommands: [shell({ output: "s".repeat(SHELL_OUTPUT_CAP) })],
    });
    // Force a tiny cap so the guard must act; the biggest field (shell output)
    // must end up smaller than it started.
    const before = utf8(record.shellCommands[0]!.output);
    const capped = enforceRecordCap(record, 4096);
    expect(serialized(capped)).toBeLessThanOrEqual(4096);
    expect(utf8(capped.shellCommands[0]!.output)).toBeLessThan(before);
  });

  test("never throws even when only tiny fields remain (nothing left to shrink)", () => {
    // A record whose structural JSON alone exceeds a pathologically tiny cap:
    // the guard bails out rather than looping forever.
    const record = rawRecord({ dispatches: [dispatch({ promptText: "", resultPreview: "" })] });
    expect(() => enforceRecordCap(record, 1)).not.toThrow();
  });

  test("shrinks a large dispatch error field too", () => {
    const record = rawRecord({ dispatches: [dispatch({ promptText: "", resultPreview: "", error: "e".repeat(50_000) })] });
    const capped = enforceRecordCap(record, 4096);
    expect(serialized(capped)).toBeLessThanOrEqual(4096);
  });
});

describe("makeStepIOSink", () => {
  test("collects dispatches and shell commands in order", () => {
    const sink = makeStepIOSink();
    expect(sink.dispatches()).toEqual([]);
    expect(sink.shellCommands()).toEqual([]);
    const d = dispatch();
    const s = shell();
    sink.recordDispatch(d);
    sink.recordShell(s);
    sink.recordShell(shell({ command: "biome check" }));
    expect(sink.dispatches()).toEqual([d]);
    expect(sink.shellCommands()).toHaveLength(2);
    expect(sink.shellCommands()[1]!.command).toBe("biome check");
  });
});
