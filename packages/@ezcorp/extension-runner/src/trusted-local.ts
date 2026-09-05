import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { readFile } from "node:fs/promises";
import type { ResourceLimits } from "@ezcorp/extension-contract";
import { PodmanRunner, type PodmanRunnerOptions } from "./podman";
import { digest, RunnerError, sha256 } from "./core";

export interface TrustedLocalApproval {
  digest: string;
  phase: "build" | "execute";
  approvedBy: string;
  expiresAt: number;
  omittedControls: string[];
}
export const TRUSTED_LOCAL_OMITTED_CONTROLS = Object.freeze(["filesystem-isolation", "network-isolation", "seccomp", "cgroup-memory", "cgroup-cpu", "cgroup-pids", "bounded-temporary-storage"]);
export interface TrustedLocalRunnerOptions extends Omit<PodmanRunnerOptions, "image" | "podman"> {
  bunPath: string;
  bunDigest: string;
  dedicatedUid: number;
  setprivPath?: string;
  approvalFor(phase: "build" | "execute", exactDigest: string): Promise<TrustedLocalApproval | null>;
  audit(event: { mode: "trusted-local"; approval: TrustedLocalApproval }): Promise<void>;
}

export class TrustedLocalRunner extends PodmanRunner {
  private readonly children = new Map<string, ChildProcessWithoutNullStreams>();
  constructor(private readonly trusted: TrustedLocalRunnerOptions) {
    super({ ...trusted, image: `localhost/trusted-local@sha256:${digest(trusted.bunDigest)}` });
  }
  protected override async probeSecurity(): Promise<void> {
    if (process.platform !== "linux" || !Number.isSafeInteger(this.trusted.dedicatedUid) || this.trusted.dedicatedUid === 0 || process.getuid?.() !== this.trusted.dedicatedUid) throw new RunnerError("trusted_account_required", "Trusted-local runner requires its configured non-root dedicated OS account");
    if (sha256(await readFile(this.trusted.bunPath)) !== this.trusted.bunDigest) throw new RunnerError("trusted_binary_changed", "Trusted-local Bun binary differs from pinned digest");
  }
  protected override async authorize(phase: "build" | "execute", exactDigest: string): Promise<void> {
    const approval = await this.trusted.approvalFor(phase, digest(exactDigest));
    if (!approval || approval.digest !== exactDigest || approval.phase !== phase || !approval.approvedBy || approval.expiresAt <= Date.now() || TRUSTED_LOCAL_OMITTED_CONTROLS.some(control => !approval.omittedControls.includes(control))) throw new RunnerError("trusted_approval_required", "Admin approval for this exact digest and omitted controls is required");
    await this.trusted.audit({ mode: "trusted-local", approval });
  }
  protected override launch(id: string, _limits: ResourceLimits, staged: string, args: string[]): ChildProcessWithoutNullStreams {
    const child = spawn(this.trusted.setprivPath ?? "setpriv", ["--no-new-privs", "--inh-caps=-all", "--ambient-caps=-all", this.trusted.bunPath, ...args], { cwd: staged, detached: true, stdio: ["pipe", "pipe", "pipe"], env: { PATH: process.env.PATH, HOME: "/nonexistent", TMPDIR: "/tmp", LANG: "C.UTF-8" } });
    this.children.set(id, child);
    return child;
  }
  protected override async remove(id: string): Promise<void> {
    const child = this.children.get(id);
    if (!child) return;
    this.children.delete(id);
    if (child.pid) { try { process.kill(-child.pid, "SIGKILL"); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; } }
  }
}
