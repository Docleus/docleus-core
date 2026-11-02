import type { Context } from "@docleus/kernel";
import type { EventDeclaration } from "./declare.ts";

/**
 * An event dispatched with a mode other than the one it was declared with.
 *
 * @stability experimental
 */
export interface DispatchMismatch {
  readonly event: string;
  readonly declared: string;
  readonly actual: string;
}

/**
 * Records every dispatch of a declared event whose mode differs from the
 * declaration. Returns the live list of mismatches; for tests.
 *
 * @stability experimental
 */
export function auditDispatchModes(
  ctx: Context,
  events: readonly EventDeclaration[],
) {
  const declared = new Map(events.map((event) => [event.name, event.mode]));
  const mismatches: DispatchMismatch[] = [];
  ctx.on("internal/dispatch", (mode, name) => {
    if (typeof name !== "string") return;
    const expected = declared.get(name);
    if (expected !== undefined && expected !== mode) {
      mismatches.push({ event: name, declared: expected, actual: mode });
    }
  });
  return mismatches;
}
