import { describe, expect, test } from "bun:test";
import { type FdClasses, fdClass, isPgliteRelationFile, isPgliteRelationPath, nonRelationPathCount, nonRelationPathGrew, relationDescriptorProblems } from "./lib/shipping-runtime-resource-accounting";

const root = "/app/data/ezcorp";
const classes: FdClasses = { socket: 1, pipe: 1, anon: 1, path: 3, other: 0 };
const valid = { fd: "9", target: `${root}/base/5/17074_fsm`, class: "path" as const, device: "8", inode: "17074", backingDevice: "8", backingInode: "17074" };

describe("R4 PGlite descriptor accounting", () => {
  test("classifies every descriptor family", () => {
    expect(fdClass("socket:[1]")).toBe("socket");
    expect(fdClass("pipe:[1]")).toBe("pipe");
    expect(fdClass("anon_inode:[eventfd]")).toBe("anon");
    expect(fdClass("/app/data/ezcorp/base/5/17074")).toBe("path");
    expect(fdClass("memfd:runtime")).toBe("other");
  });

  test("accepts a distinct live relation backing file", () => {
    expect(isPgliteRelationPath(root, valid.target)).toBe(true);
    expect(isPgliteRelationFile(`${root}/base/5/17074_fsm.1`)).toBe(true);
    expect(isPgliteRelationFile(`${root}/base/5/17074.1`)).toBe(true);
    expect(relationDescriptorProblems(root, [valid, { ...valid, fd: "10", target: `${root}/base/5/17108_fsm`, inode: "17108", backingInode: "17108" }])).toEqual([]);
    expect(nonRelationPathCount({ classes, pgliteRelationDescriptors: [valid, { ...valid, fd: "10", target: `${root}/base/5/17108_fsm`, inode: "17108", backingInode: "17108" }] })).toBe(1);
  });

  test("rejects retained duplicate, deleted, missing, mismatched, and escaped relation handles", () => {
    expect(relationDescriptorProblems(root, [valid, { ...valid, fd: "10" }]).join("\n")).toContain("duplicates an open backing inode");
    expect(relationDescriptorProblems(root, [{ ...valid, target: `${root}/base/5/17074_fsm (deleted)` }]).join("\n")).toContain("escaped the data root");
    expect(relationDescriptorProblems(root, [{ ...valid, backingMissing: true, backingDevice: undefined, backingInode: undefined }]).join("\n")).toContain("no live backing file");
    expect(relationDescriptorProblems(root, [{ ...valid, backingInode: "other" }]).join("\n")).toContain("does not match its backing file");
    expect(relationDescriptorProblems(root, [{ ...valid, target: "/app/data/ezcorp-backup/base/5/17074_fsm" }]).join("\n")).toContain("escaped the data root");
  });

  test("rejects non-relation path growth while allowing a live relation to grow", () => {
    const baseline = { classes: { ...classes, path: 2 }, pgliteRelationDescriptors: [valid] };
    expect(nonRelationPathGrew(baseline, { classes: { ...classes, path: 3 }, pgliteRelationDescriptors: [valid] })).toBe(true);
    expect(nonRelationPathGrew(baseline, { classes: { ...classes, path: 3 }, pgliteRelationDescriptors: [valid, { ...valid, fd: "10", target: `${root}/base/5/17108_fsm`, inode: "17108", backingInode: "17108" }] })).toBe(false);
  });
});
