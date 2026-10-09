/** Resolve the real host interpreter for portable preview/guest fixtures. */
export function hostPython3(): string {
  const python3 = Bun.which("python3");
  if (!python3) throw new Error("Preview relay tests require python3 on PATH");
  return python3;
}
