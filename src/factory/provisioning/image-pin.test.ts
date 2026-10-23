import { expect, test } from "bun:test";
import { factoryImagePinned } from "./image-pin";

const DIGEST = `sha256:${"a".repeat(64)}`;

test("an image is pinned only by a full sha256 digest after a name with no whitespace", () => {
  for (const reference of [`docker.io/x@${DIGEST}`, `docker.io/oven/bun:1.4.2@${DIGEST}`, `localhost/ezcorp-factory@${DIGEST}`]) expect(factoryImagePinned(reference)).toBe(true);
  for (const reference of ["nginx:latest", `x@sha256:${"a".repeat(63)}`, `x@sha256:${"A".repeat(64)}`, `@${DIGEST}`, `a b@${DIGEST}`, `a@b@${DIGEST}`, `\${EZCORP_FACTORY_POOL_IMAGE:?}`, "", 7, undefined]) {
    expect(factoryImagePinned(reference)).toBe(false);
  }
});
