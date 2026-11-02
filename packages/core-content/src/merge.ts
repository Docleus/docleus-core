import type {
  EntryContent,
  EntryField,
  EntrySet,
  MergeConflict,
  MergeInput,
  MergeResult,
} from "@docleus/sdk";
import { mergeBodies } from "./merge-body.ts";
import { repairTree } from "./merge-repair.ts";
import {
  createConflictSink,
  readEntryValue,
  readFieldValue,
  type ConflictSink,
  type FieldValues,
} from "./merge-resolution.ts";
import {
  compareStrings,
  conflictDigest,
  isEqual,
  otherSide,
  SIDES,
  threeWay,
  type Side,
} from "./merge-values.ts";

type Fields = Readonly<Record<string, unknown>>;

interface Versions<T> {
  readonly base: T | undefined;
  readonly ours: T;
  readonly theirs: T;
}

/**
 * Three-way merge of entry sets; see {@link MergeConflict} and
 * {@link MergeResolution} for the rules. Every conflict is decided both
 * ways (keeping `ours`, and keeping `theirs`) so that repairs of the
 * entry and block trees, which depend on those decisions, report the
 * same conflicts whichever side is `ours`. The result is the `ours` run.
 */
export function mergeEntrySets(input: MergeInput): MergeResult {
  const resolutions = input.resolutions ?? {};
  const conflicts = new Map<string, MergeConflict>();
  const [entries = {}] = SIDES.map((fallback) =>
    mergeWith(input, createConflictSink(resolutions, fallback, conflicts)),
  );
  return {
    entries,
    conflicts: [...conflicts.values()].toSorted((a, b) =>
      compareStrings(a.id, b.id),
    ),
  };
}

function entryIn(set: EntrySet, id: string): EntryContent | undefined {
  return Object.hasOwn(set, id) ? set[id] : undefined;
}

function mergeWith(input: MergeInput, sink: ConflictSink): EntrySet {
  const { base } = input;
  const sets: Record<Side, EntrySet> = {
    ours: input.ours,
    theirs: input.theirs,
  };
  const changedBelow = {
    ours: changedDescendants(base, input.ours),
    theirs: changedDescendants(base, input.theirs),
  };

  const ids = [
    ...new Set([
      ...Object.keys(base),
      ...Object.keys(input.ours),
      ...Object.keys(input.theirs),
    ]),
  ].toSorted(compareStrings);
  const merged = new Map<string, EntryContent>();
  for (const id of ids) {
    const entry = mergeEntry(id);
    if (entry) merged.set(id, entry);
  }

  repairTree(merged, {
    placeAs(side, id, node) {
      const version = entryIn(sets[side], id);
      if (!version) return undefined;
      return { ...node, parent: version.parent, order: version.order };
    },
    deletedBy(id) {
      const hasOurs = entryIn(input.ours, id) !== undefined;
      if (hasOurs === (entryIn(input.theirs, id) !== undefined)) {
        return undefined;
      }
      return hasOurs ? "theirs" : "ours";
    },
    resolve(problem) {
      const entryIds = problem.kind === "dangling" ? [problem.id] : problem.ids;
      const positions = (set: EntrySet) =>
        entryIds.map((id) => {
          const entry = entryIn(set, id);
          return entry ? { parent: entry.parent, order: entry.order } : null;
        });
      const digest = conflictDigest(
        positions(base),
        positions(input.ours),
        positions(input.theirs),
      );
      const decision = sink.decide({
        id: `tree:${entryIds.join(",")}:${digest}`,
        kind: "tree",
        entryIds,
      });
      const side = decision.side ?? sink.fallback;
      return () => side;
    },
  });

  return Object.fromEntries(
    [...merged].toSorted(([a], [b]) => compareStrings(a, b)),
  );

  function mergeEntry(id: string): EntryContent | undefined {
    const before = entryIn(base, id);
    const versions: Record<Side, EntryContent | undefined> = {
      ours: entryIn(input.ours, id),
      theirs: entryIn(input.theirs, id),
    };
    if (isEqual(versions.ours, versions.theirs)) return versions.ours;
    if (!before) {
      if (!versions.ours) return versions.theirs;
      if (!versions.theirs) return versions.ours;
      return mergeFields(id, undefined, versions.ours, versions.theirs);
    }
    for (const side of SIDES) {
      const other = otherSide(side);
      const isUnchanged = isEqual(versions[side], before);
      const isDeletedByOther = versions[other] === undefined;
      if (isUnchanged && !(isDeletedByOther && changedBelow[side].has(id))) {
        return versions[other];
      }
    }
    if (versions.ours && versions.theirs) {
      return mergeFields(id, before, versions.ours, versions.theirs);
    }
    const conflict: MergeConflict & { readonly kind: "entry-deleted" } = {
      id: `entry-deleted:${id}:${conflictDigest(before, versions.ours, versions.theirs)}`,
      kind: "entry-deleted",
      entryId: id,
      base: before,
      ours: versions.ours,
      theirs: versions.theirs,
    };
    const decision = sink.decide(conflict);
    if (decision.side !== undefined) return versions[decision.side];
    return readEntryValue(conflict, decision.value);
  }

  function mergeFields(
    id: string,
    before: EntryContent | undefined,
    ours: EntryContent,
    theirs: EntryContent,
  ): EntryContent {
    const valuesOf = <T>(read: (entry: EntryContent) => T): Versions<T> => ({
      base: before ? read(before) : undefined,
      ours: read(ours),
      theirs: read(theirs),
    });
    const pick = <F extends "type" | "title" | "position">(
      field: F,
      values: Versions<FieldValues[F]>,
    ): FieldValues[F] => {
      const result = threeWay(values.base, values.ours, values.theirs);
      if (!result.isConflict) return result.value;
      const conflict = fieldConflict(id, field, values);
      const decision = sink.decide(conflict);
      return decision.side === undefined
        ? readFieldValue(conflict, field, decision.value)
        : values[decision.side];
    };

    const type = pick(
      "type",
      valuesOf((entry) => entry.type),
    );
    const title = pick(
      "title",
      valuesOf((entry) => entry.title),
    );
    const position = pick(
      "position",
      valuesOf((entry) => ({ parent: entry.parent, order: entry.order })),
    );
    const fields =
      mergeRecord(
        "fields",
        valuesOf((entry) => entry.fields),
      ) ?? {};
    const meta = mergeRecord(
      "meta",
      valuesOf((entry) => entry.meta),
    );
    const body = mergeBody(id, before, ours, theirs);
    return {
      type,
      title,
      parent: position.parent,
      order: position.order,
      fields,
      ...(body !== undefined && { body }),
      ...(meta !== undefined && { meta }),
    };

    function mergeRecord(
      field: "fields" | "meta",
      values: Versions<Fields | undefined>,
    ): Fields | undefined {
      const whole = threeWay(values.base, values.ours, values.theirs);
      if (!whole.isConflict) return whole.value;
      const keys = new Set(
        [values.base, values.ours, values.theirs].flatMap((value) =>
          Object.keys(value ?? {}),
        ),
      );
      const result: Record<string, unknown> = {};
      const conflicting: string[] = [];
      for (const key of [...keys].toSorted(compareStrings)) {
        const outcome = threeWay(
          values.base?.[key],
          values.ours?.[key],
          values.theirs?.[key],
        );
        if (outcome.isConflict) conflicting.push(key);
        else if (outcome.value !== undefined) result[key] = outcome.value;
      }
      if (conflicting.length > 0) {
        const conflict = fieldConflict(id, field, values);
        const decision = sink.decide(conflict);
        if (decision.side === undefined) {
          return readFieldValue(conflict, field, decision.value);
        }
        const chosen = values[decision.side];
        for (const key of conflicting) {
          if (chosen?.[key] !== undefined) result[key] = chosen[key];
        }
      }
      const isEmpty = Object.keys(result).length === 0;
      return field === "meta" &&
        isEmpty &&
        (values.ours === undefined || values.theirs === undefined)
        ? undefined
        : result;
    }
  }

  function mergeBody(
    id: string,
    before: EntryContent | undefined,
    ours: EntryContent,
    theirs: EntryContent,
  ) {
    const whole = threeWay(before?.body, ours.body, theirs.body);
    if (!whole.isConflict) return whole.value;
    return mergeBodies({
      entryId: id,
      base: before?.body,
      ours: ours.body,
      theirs: theirs.body,
      sink,
    });
  }
}

function fieldConflict(
  entryId: string,
  field: EntryField,
  values: Versions<unknown>,
): MergeConflict & { readonly kind: "entry" } {
  const digest = conflictDigest(values.base, values.ours, values.theirs);
  return {
    id: `entry:${entryId}:${field}:${digest}`,
    kind: "entry",
    entryId,
    field,
    ...values,
  };
}

/** Entries of `side` with a descendant (in that side's tree) that is new or changed. */
function changedDescendants(base: EntrySet, side: EntrySet): Set<string> {
  const result = new Set<string>();
  for (const [id, entry] of Object.entries(side)) {
    const before = Object.hasOwn(base, id) ? base[id] : undefined;
    if (isEqual(entry, before)) continue;
    const seen = new Set([id]);
    let parent = entry.parent;
    while (parent !== undefined && !seen.has(parent)) {
      seen.add(parent);
      result.add(parent);
      parent = Object.hasOwn(side, parent) ? side[parent]?.parent : undefined;
    }
  }
  return result;
}
