import { expect, test } from "bun:test";
import { canonicalJson, encodeWorkspaceFile, validateWorkspaceFiles, workspaceFileByteLength, workspaceFileBytes, workspaceFileChecksum, workspaceText } from "./validation";

test("binary bytes and executable mode survive canonical transport", async () => {
  const bytes = new Uint8Array([0, 255, 137, 80, 78, 71]);
  const file = encodeWorkspaceFile(bytes);
  expect(file).toEqual({ encoding: "base64", data: "AP+JUE5H", executable: false });
  const executable = encodeWorkspaceFile(bytes, true);
  expect(workspaceFileBytes(file)).toEqual(bytes);
  expect(workspaceFileByteLength(file)).toBe(bytes.length);
  expect(validateWorkspaceFiles(JSON.parse(canonicalJson({ "asset.png": file, "bin/tool": executable })))).toEqual({ "asset.png": file, "bin/tool": executable });
  expect(await workspaceFileChecksum(file)).not.toBe(await workspaceFileChecksum(executable));
});

test("text stays text including BOM while executable text preserves its mode", () => {
  for (const text of ["", "hello", "😀", "\uFEFFtext"]) {
    const bytes = new TextEncoder().encode(text);
    expect(encodeWorkspaceFile(bytes)).toBe(text);
    expect(workspaceFileBytes(text)).toEqual(bytes);
    expect(workspaceFileByteLength(text)).toBe(bytes.length);
    expect(workspaceText(text, "source.ts")).toBe(text);
  }
  expect(encodeWorkspaceFile(new TextEncoder().encode("#!/bin/sh\nexit 0"), true)).toMatchObject({ encoding: "base64", executable: true });
  expect(encodeWorkspaceFile(new Uint8Array([255]))).toEqual({ encoding: "base64", data: "/w==", executable: false });
  expect(workspaceFileByteLength({ encoding: "base64", data: "AQI=", executable: false })).toBe(2);
});

test("malformed binary fields and noncanonical base64 fail before materialization", () => {
  for (const value of [null, [], 1, {}, { encoding: "base64", data: "", executable: false, extra: true }, { encoding: "hex", data: "", executable: false }, { encoding: "base64", data: "", executable: 1 }]) {
    expect(() => workspaceFileByteLength(value)).toThrow();
  }
  for (const data of ["A", "AA=A", "AA-_", "AA\n=", "AB==", "AAF=", "===="]) {
    expect(() => workspaceFileBytes({ encoding: "base64", data, executable: false })).toThrow();
  }
  expect(() => workspaceFileByteLength({ encoding: "base64", data: "A".repeat(224 * 1024 * 1024 + 1), executable: false })).toThrow("size limit");
});

test("binary assets respect decoded size, paths, and text-only source constraints", () => {
  const file = { encoding: "base64" as const, data: "AA==", executable: false };
  for (const path of ["extension.ts", "package.json", "tsconfig.json", "ezcorp.config.ts", "setup.yaml"]) {
    expect(() => validateWorkspaceFiles({ [path]: file })).toThrow("must be text");
  }
  expect(() => validateWorkspaceFiles({ asset: file, "asset/child": "x" })).toThrow("conflicts");
  expect(() => validateWorkspaceFiles({ "../asset": file })).toThrow();
  expect(() => workspaceText(undefined, "missing.ts")).toThrow("must be text");
  expect(() => validateWorkspaceFiles({ "asset.bin": { ...file, data: "AAAA".repeat(7 * 1024 * 1024) } })).toThrow("20 MiB");
});
