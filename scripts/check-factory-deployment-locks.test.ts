import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { checkFactoryDeploymentLocks, composeImages, dockerfileArtifacts, dockerfileImages, factoryLockCheckIo, runFactoryDeploymentLockCheck, unpinnedFactoryImages } from "./check-factory-deployment-locks";

const DIGEST = `sha256:${"a".repeat(64)}`;
let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "factory-locks-"));
  await mkdir(join(root, "deploy/factory/compose"), { recursive: true });
  await mkdir(join(root, "deploy/factory/kubernetes"), { recursive: true });
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

describe("image references", () => {
  test("a Dockerfile yields its ARG image defaults and literal FROM images, not FROM variables", () => {
    const text = [`ARG BUN_IMAGE=docker.io/oven/bun:1@${DIGEST}`, "ARG OTHER=1", `FROM \${BUN_IMAGE} AS builder`, "FROM docker.io/library/debian:12", "RUN true"].join("\n");
    expect(dockerfileImages("Dockerfile", text)).toEqual([
      { file: "Dockerfile", line: 1, reference: `docker.io/oven/bun:1@${DIGEST}` },
      { file: "Dockerfile", line: 4, reference: "docker.io/library/debian:12" },
    ]);
  });

  test("a Compose template yields every image, unquoted", () => {
    const text = ["services:", "  a:", `    image: docker.io/x@${DIGEST}`, "  b:", `    image: "\${EZCORP_FACTORY_POOL_IMAGE:?}"`, "    command: [image]", "  c:", "    image: 'nginx:latest' # comment"].join("\n");
    expect(composeImages("t.yml", text).map((entry) => [entry.line, entry.reference])).toEqual([[3, `docker.io/x@${DIGEST}`], [5, `\${EZCORP_FACTORY_POOL_IMAGE:?}`], [8, "nginx:latest"]]);
  });

  test("a download is pinned only by a sha256sum check of its destination in the very next RUN; a RUN that fetches is never pinned (W4H-35)", () => {
    const url = "https://github.com/containers/podman/releases/download/v5.8.7/podman-remote-static-linux_amd64.tar.gz";
    const sum = "b".repeat(64);
    const text = [
      `ADD ${url} /tmp/podman-remote.tar.gz`, `RUN echo "${sum}  /tmp/podman-remote.tar.gz" | sha256sum -c - \\`, "  && tar -xzf /tmp/podman-remote.tar.gz",
      `ADD ${url} /tmp/x.tar.gz`,
      `ADD ${url} /tmp/other.tar.gz`, `RUN echo "${sum}  /tmp/x.tar.gz" | sha256sum -c -`,
      `ADD ${url} /tmp/short.tar.gz`, `RUN echo "${"b".repeat(63)}  /tmp/short.tar.gz" | sha256sum -c -`,
      `ADD ${url} /tmp/late.tar.gz`, "RUN true", `RUN echo "${sum}  /tmp/late.tar.gz" | sha256sum -c -`,
      `ADD ${url} /tmp/commented.tar.gz`, "# the check comes next", "", `RUN echo "${sum}  /tmp/commented.tar.gz" | sha256sum -c -`,
      "ADD ./local /app", "RUN curl -fsSL https://x/z | sh", "RUN wget https://x/w",
    ].join("\n");
    expect(dockerfileArtifacts("Dockerfile", text)).toEqual([
      { file: "Dockerfile", line: 1, reference: url, pinned: true },
      { file: "Dockerfile", line: 4, reference: url, pinned: false },
      { file: "Dockerfile", line: 5, reference: url, pinned: false },
      { file: "Dockerfile", line: 7, reference: url, pinned: false },
      { file: "Dockerfile", line: 9, reference: url, pinned: false },
      { file: "Dockerfile", line: 12, reference: url, pinned: true },
      { file: "Dockerfile", line: 17, reference: "RUN curl -fsSL https://x/z | sh", pinned: false },
      { file: "Dockerfile", line: 18, reference: "RUN wget https://x/w", pinned: false },
    ]);
  });

  test("ADD --checksum is refused even with a valid sum: the hosted builder (Podman 4.9.3, Buildah 1.33) rejects the flag (W4H-35 ci 39956956620)", () => {
    const url = "https://github.com/containers/podman/releases/download/v5.8.7/podman-remote-static-linux_amd64.tar.gz";
    const text = [`ADD --checksum=sha256:${"b".repeat(64)} ${url} /tmp/podman-remote.tar.gz`, `RUN echo "${"b".repeat(64)}  /tmp/podman-remote.tar.gz" | sha256sum -c -`].join("\n");
    expect(dockerfileArtifacts("Dockerfile", text)).toEqual([{ file: "Dockerfile", line: 1, reference: url, pinned: false, checksumFlag: true }]);
  });

  test("only a digest pin or a provisioner-rendered installation image passes", () => {
    const refs = ["docker.io/x@" + DIGEST, `\${EZCORP_FACTORY_POOL_IMAGE:?}`, "nginx:latest", "docker.io/x@sha256:short", `\${OTHER_IMAGE}`].map((reference, line) => ({ file: "f", line, reference }));
    expect(unpinnedFactoryImages(refs).map((entry) => entry.reference)).toEqual(["nginx:latest", "docker.io/x@sha256:short", `\${OTHER_IMAGE}`]);
  });
});

describe("the check over a deployment tree", () => {
  async function tree(composeImage: string, kubernetesImage = `docker.io/kindest/node:v1@${DIGEST}`): Promise<void> {
    await writeFile(join(root, "deploy/factory/Dockerfile"), `ARG BUN_IMAGE=docker.io/oven/bun@${DIGEST}\nFROM \${BUN_IMAGE}\n`);
    await writeFile(join(root, "deploy/factory/compose/platform.yml"), `services:\n  a:\n    image: ${composeImage}\n`);
    await writeFile(join(root, "deploy/factory/compose/README.md"), "image: not-a-template\n");
    await writeFile(join(root, "deploy/factory/kubernetes/kind-proof.yml"), `kind: Cluster\nnodes:\n  - role: control-plane\n    image: ${kubernetesImage}\n`);
  }

  test("a pinned tree passes and counts every reference", async () => {
    await tree(`docker.io/x@${DIGEST}`);
    expect(await checkFactoryDeploymentLocks(root)).toEqual({ checked: 3, unpinned: [] });
  });

  test("a Kubernetes template's image is checked like a Compose one (one lock mechanism for both profiles)", async () => {
    await tree(`docker.io/x@${DIGEST}`, "docker.io/kindest/node:v1.36.1");
    expect((await checkFactoryDeploymentLocks(root)).unpinned).toEqual([{ file: "deploy/factory/kubernetes/kind-proof.yml", line: 4, reference: "docker.io/kindest/node:v1.36.1" }]);
  });

  test("the entry prints each unpinned image with its place and exits 1", async () => {
    await tree("nginx:latest");
    const lines: string[] = []; let exit = -1;
    const entry = resolve(import.meta.dir, "check-factory-deployment-locks.ts");
    await runFactoryDeploymentLockCheck(["bun", entry], pathToFileURL(entry).href, root, { log: (line) => lines.push(line), exit: (code) => { exit = code; } });
    expect(lines).toEqual(["deploy/factory/compose/platform.yml:3: image nginx:latest is not pinned by digest", "1 of 3 image and download references are not pinned."]);
    expect(exit).toBe(1);
  });

  test("the entry names a download that has no sha256 (W4H-35)", async () => {
    await tree(`docker.io/x@${DIGEST}`);
    await writeFile(join(root, "deploy/factory/Dockerfile"), `ARG BUN_IMAGE=docker.io/oven/bun@${DIGEST}\nFROM \${BUN_IMAGE}\nADD https://example.test/tool.tar.gz /tmp/tool.tar.gz\n`);
    const lines: string[] = []; let exit = -1;
    const entry = resolve(import.meta.dir, "check-factory-deployment-locks.ts");
    await runFactoryDeploymentLockCheck(["bun", entry], pathToFileURL(entry).href, root, { log: (line) => lines.push(line), exit: (code) => { exit = code; } });
    expect(lines).toEqual(["deploy/factory/Dockerfile:3: download https://example.test/tool.tar.gz is not pinned by sha256", "1 of 4 image and download references are not pinned."]);
    expect(exit).toBe(1);
  });

  test("the entry names an ADD --checksum as refused by the hosted builder (W4H-35 ci 39956956620)", async () => {
    await tree(`docker.io/x@${DIGEST}`);
    await writeFile(join(root, "deploy/factory/Dockerfile"), `ARG BUN_IMAGE=docker.io/oven/bun@${DIGEST}\nFROM \${BUN_IMAGE}\nADD --checksum=sha256:${"c".repeat(64)} https://example.test/tool.tar.gz /tmp/tool.tar.gz\n`);
    const lines: string[] = []; let exit = -1;
    const entry = resolve(import.meta.dir, "check-factory-deployment-locks.ts");
    await runFactoryDeploymentLockCheck(["bun", entry], pathToFileURL(entry).href, root, { log: (line) => lines.push(line), exit: (code) => { exit = code; } });
    expect(lines).toEqual(["deploy/factory/Dockerfile:3: download https://example.test/tool.tar.gz uses ADD --checksum, which the hosted builder refuses; check its sha256 with sha256sum -c in the next RUN", "1 of 4 image and download references are not pinned."]);
    expect(exit).toBe(1);
  });

  test("the entry reports success and exits 0; it does nothing when imported", async () => {
    await tree(`docker.io/x@${DIGEST}`);
    const lines: string[] = []; let exit = -1;
    const entry = resolve(import.meta.dir, "check-factory-deployment-locks.ts");
    const io = { log: (line: string) => lines.push(line), exit: (code: number) => { exit = code; } };
    await runFactoryDeploymentLockCheck(["bun", entry], pathToFileURL(entry).href, root, io);
    expect([lines, exit]).toEqual([["Factory deployment locks OK: 3 image and download references, all pinned."], 0]);
    await runFactoryDeploymentLockCheck(["bun", "/elsewhere.ts"], pathToFileURL(entry).href, root, io);
    await runFactoryDeploymentLockCheck(["bun"], pathToFileURL(entry).href, root, io);
    expect(lines).toHaveLength(1);
  });

  test("the real repository is pinned", async () => {
    const result = await checkFactoryDeploymentLocks(resolve(import.meta.dir, ".."));
    expect(result.unpinned).toEqual([]);
    expect(result.checked).toBeGreaterThan(5);
    expect((await readFile(resolve(import.meta.dir, "../deploy/factory/kubernetes/kind-proof.yml"), "utf8"))).toMatch(/image: docker\.io\/kindest\/node:v[0-9.]+@sha256:[0-9a-f]{64}\n/);
    // The supervisor's podman-remote client: a Podman 5.x release artifact, pinned by sha256 (C12 row "Supervisor container runtime").
    const artifacts = dockerfileArtifacts("deploy/factory/Dockerfile", await readFile(resolve(import.meta.dir, "../deploy/factory/Dockerfile"), "utf8"));
    expect(artifacts.map((entry) => [entry.reference.replace(/\/v5\.[0-9]+\.[0-9]+\//, "/v5.x/"), entry.pinned])).toEqual([["https://github.com/containers/podman/releases/download/v5.x/podman-remote-static-linux_amd64.tar.gz", true]]);
  });
});

test("the default output prints a line and sets the process exit code", () => {
  const print = spyOn(console, "log").mockImplementation(() => undefined);
  const previous = process.exitCode;
  try {
    factoryLockCheckIo.log("line");
    factoryLockCheckIo.exit(3);
    expect(print).toHaveBeenCalledWith("line");
    expect(process.exitCode).toBe(3);
  } finally { process.exitCode = previous ?? 0; print.mockRestore(); } // Bun 1.3.14 keeps the 3 when handed undefined
});

test("the default root is the repository", async () => {
  const lines: string[] = [];
  const entry = resolve(import.meta.dir, "check-factory-deployment-locks.ts");
  await runFactoryDeploymentLockCheck(["bun", entry], pathToFileURL(entry).href, undefined, { log: (line) => lines.push(line), exit: () => undefined });
  expect(lines.at(-1)).toMatch(/^Factory deployment locks OK: \d+ image and download references, all pinned\.$/);
});

describe("the deployment files keep the fixes the live runs needed", () => {
  const repository = resolve(import.meta.dir, "..");

  test("the image makes /app readable by the host user's uid, in the builder stage, before the runtime stage copies it", async () => {
    const lines = (await Bun.file(join(repository, "deploy/factory/Dockerfile")).text()).split("\n").map((line) => line.trim());
    const chmod = lines.indexOf("RUN chmod -R a+rX,go-w /app");
    const runtimeCopy = lines.indexOf("COPY --from=builder /app /app");
    const runtimeStage = lines.findIndex((line, index) => index > 0 && /^FROM \$\{BUN_RUNTIME_IMAGE\}/.test(line));
    expect(chmod).toBeGreaterThan(-1);
    expect(chmod).toBeLessThan(runtimeStage);
    expect(runtimeStage).toBeLessThan(runtimeCopy);
  });

  test("the Temporal gateway's Envoy runs as the container's root, which is the host user owning its mounted config", async () => {
    const platform = Bun.YAML.parse(await Bun.file(join(repository, "deploy/factory/compose/platform.yml")).text()) as { services: Record<string, { environment?: Record<string, string> }> };
    expect(platform.services["factory-temporal-gateway"]!.environment).toEqual({ ENVOY_UID: "0" });
  });
});
