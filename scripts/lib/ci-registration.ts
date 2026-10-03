/**
 * Shared primitives for CI registration tests.
 *
 * Every `scripts/factory-*-registration.test.ts` asks the same two questions:
 * "does a workflow actually RUN this producer?" and "is this source floored at
 * 100 in the coverage thresholds?". Each file had its own copy of both, so a
 * fix to one (for example, ignoring a needle that only appears in a comment)
 * never reached the others. These are the single definitions.
 */

/** A required producer: a reviewable label plus the exact text a workflow must contain. */
export type RequiredProducer = readonly [label: string, needle: string];

/**
 * Strip `#` comments so a producer can never be "registered" by a comment that
 * merely mentions it. A `#` inside a quoted string is left alone.
 */
export function workflowCommands(workflow: string): string {
  return workflow
    .split("\n")
    .map((line) => {
      let quote: string | undefined;
      for (let index = 0; index < line.length; index++) {
        const character = line[index]!;
        if (quote) {
          if (character === quote) quote = undefined;
        } else if (character === '"' || character === "'") {
          quote = character;
        } else if (character === "#" && (index === 0 || /\s/.test(line[index - 1]!))) {
          return line.slice(0, index).trimEnd();
        }
      }
      return line;
    })
    .join("\n");
}

/** Labels of every required producer the workflow does not actually run. */
export function missingProducers(workflow: string, required: readonly RequiredProducer[]): string[] {
  const commands = workflowCommands(workflow);
  return required.filter(([, needle]) => !commands.includes(needle)).map(([label]) => label);
}

/** Sources without an exact 100% floor in scripts/coverage-thresholds.json. */
export function missingThresholds(thresholds: string, sources: readonly string[]): string[] {
  return sources.filter((source) => !thresholds.includes(`"${source}": 100`)).map((source) => `${source} threshold`);
}
