/** The one rule every factory deployment image obeys: pinned by its full sha256 digest (deployment locks, C12). */
const PINNED_IMAGE = /^[^@\s]+@sha256:[a-f0-9]{64}$/;

export function factoryImagePinned(reference: unknown): reference is string {
  return typeof reference === "string" && PINNED_IMAGE.test(reference);
}
