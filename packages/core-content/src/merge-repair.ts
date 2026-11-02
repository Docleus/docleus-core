import { compareStrings, type Side } from "./merge-values.ts";

export interface TreeNode {
  /** `undefined` at the top of the tree. */
  readonly parent: string | undefined;
}

export type TreeProblem =
  | {
      readonly kind: "dangling";
      readonly id: string;
      readonly parent: string;
    }
  | { readonly kind: "cycle"; readonly ids: readonly string[] };

export interface TreeRepairHooks<N extends TreeNode> {
  /** `node` placed where `side` has it, or `undefined` when that side does not have it. */
  readonly placeAs: (side: Side, id: string, node: N) => N | undefined;
  /** The only side that does not have `id`, if exactly one lacks it. */
  readonly deletedBy: (id: string) => Side | undefined;
  /** Records the problem as a conflict; returns the side each member is repaired with. */
  readonly resolve: (problem: TreeProblem) => (id: string) => Side;
}

/** Each node is moved at most twice before it is dropped, which bounds the repair. */
const MAX_REPAIRS = 2;

/**
 * Repairs `nodes` in place until every parent exists and there are no
 * cycles. A node whose parent one side deleted is placed as that side has
 * it (or dropped when that side does not have it either), silently: the
 * delete already decided it. Other problems are reported through `resolve`.
 */
export function repairTree<N extends TreeNode>(
  nodes: Map<string, N>,
  hooks: TreeRepairHooks<N>,
): void {
  const repairs = new Map<string, number>();
  const tryRepair = (id: string, side: Side, isDangling: boolean): boolean => {
    const node = nodes.get(id);
    if (!node) return false;
    const count = (repairs.get(id) ?? 0) + 1;
    repairs.set(id, count);
    const placed =
      count > MAX_REPAIRS ? undefined : hooks.placeAs(side, id, node);
    if (placed && placed.parent !== node.parent) {
      nodes.set(id, placed);
      return true;
    }
    if (isDangling || count > MAX_REPAIRS) {
      nodes.delete(id);
      return true;
    }
    return false;
  };

  for (;;) {
    const problems = findProblems(nodes);
    if (problems.length === 0) return;
    for (const problem of problems) {
      if (problem.kind === "dangling") {
        const side =
          hooks.deletedBy(problem.parent) ?? hooks.resolve(problem)(problem.id);
        tryRepair(problem.id, side, true);
        continue;
      }
      const sideOf = hooks.resolve(problem);
      let isChanged = false;
      for (const id of problem.ids) {
        if (tryRepair(id, sideOf(id), false)) isChanged = true;
      }
      const first = problem.ids[0];
      if (!isChanged && first !== undefined) nodes.delete(first);
    }
  }
}

function findProblems<N extends TreeNode>(
  nodes: ReadonlyMap<string, N>,
): TreeProblem[] {
  const problems: TreeProblem[] = [];
  const done = new Set<string>();
  for (const id of [...nodes.keys()].toSorted(compareStrings)) {
    const parent = nodes.get(id)?.parent;
    if (parent !== undefined && !nodes.has(parent)) {
      problems.push({ kind: "dangling", id, parent });
    }
  }
  for (const start of [...nodes.keys()].toSorted(compareStrings)) {
    const path: string[] = [];
    const onPath = new Set<string>();
    let current: string | undefined = start;
    while (current !== undefined && !done.has(current) && nodes.has(current)) {
      if (onPath.has(current)) {
        const cycle = path.slice(path.indexOf(current));
        problems.push({ kind: "cycle", ids: cycle.toSorted(compareStrings) });
        break;
      }
      onPath.add(current);
      path.push(current);
      current = nodes.get(current)?.parent;
    }
    for (const id of path) done.add(id);
  }
  return problems;
}
