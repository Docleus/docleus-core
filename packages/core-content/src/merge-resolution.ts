import { DocleusError } from "@docleus/kernel";
import type {
  BlockNode,
  EntryContent,
  EntryField,
  MergeConflict,
  MergeResolution,
} from "@docleus/sdk";
import { z } from "zod";
import { parseEntryContent } from "./entry.ts";
import type { Side } from "./merge-values.ts";

export const INVALID_RESOLUTION = "content/invalid-resolution";

export type Decision =
  | { readonly side: Side }
  | { readonly value: unknown; readonly side?: undefined };

export type Resolutions = Readonly<Record<string, MergeResolution>>;

/**
 * Collects conflicts and settles them: a matching resolution decides,
 * otherwise the conflict is recorded and `fallback` decides.
 */
export interface ConflictSink {
  readonly fallback: Side;
  decide(conflict: MergeConflict): Decision;
}

export function createConflictSink(
  resolutions: Resolutions,
  fallback: Side,
  conflicts: Map<string, MergeConflict>,
): ConflictSink {
  return {
    fallback,
    decide(conflict) {
      const resolution = Object.hasOwn(resolutions, conflict.id)
        ? resolutions[conflict.id]
        : undefined;
      if (resolution === undefined) {
        conflicts.set(conflict.id, conflict);
        return { side: fallback };
      }
      return readResolution(conflict, resolution);
    },
  };
}

function readResolution(
  conflict: MergeConflict,
  resolution: unknown,
): Decision {
  if (resolution === null || typeof resolution !== "object") {
    throw invalid(conflict, "must be an object");
  }
  if ("take" in resolution) {
    if (resolution.take !== "ours" && resolution.take !== "theirs") {
      throw invalid(conflict, `"take" must be "ours" or "theirs"`);
    }
    return { side: resolution.take };
  }
  if ("value" in resolution) {
    if (conflict.kind === "block-position" || conflict.kind === "tree") {
      throw invalid(conflict, `a ${conflict.kind} conflict takes a side only`);
    }
    return { value: resolution.value };
  }
  throw invalid(conflict, `needs "take" or "value"`);
}

function invalid(conflict: MergeConflict, reason: string): DocleusError {
  return new DocleusError(
    INVALID_RESOLUTION,
    `resolution for conflict "${conflict.id}" ${reason}`,
  );
}

const record = z.record(z.string(), z.unknown());

const ownBlockSchema = z
  .object({
    id: z.string().min(1),
    type: z.string().min(1),
    v: z.number().int().positive(),
    attrs: record,
    inline: z.array(record).optional(),
  })
  .loose();

const positionSchema = z.object({
  parent: z.string().min(1).nullable().optional(),
  order: z.number().finite(),
});

/** A block's own content (no `content`) or `undefined` for a deletion. */
export function readBlockValue(
  conflict: MergeConflict & { readonly kind: "block" },
  value: unknown,
  isIdFixed: boolean,
): Omit<BlockNode, "content"> | undefined {
  if (value === null) return undefined;
  const parsed = ownBlockSchema.safeParse(value);
  if (!parsed.success) {
    throw invalid(conflict, `is not a block: ${parsed.error.message}`);
  }
  if ("content" in parsed.data) {
    throw invalid(conflict, `must not carry "content"`);
  }
  if (isIdFixed && parsed.data.id !== conflict.blockId) {
    throw invalid(conflict, `must keep the block id "${conflict.blockId}"`);
  }
  return parsed.data as Omit<BlockNode, "content">;
}

/** An entry or `undefined` for a deletion. */
export function readEntryValue(
  conflict: MergeConflict & { readonly kind: "entry-deleted" },
  value: unknown,
): EntryContent | undefined {
  if (value === null) return undefined;
  return parseEntryContent(
    value,
    INVALID_RESOLUTION,
    `resolution for conflict "${conflict.id}"`,
  );
}

export interface FieldValues {
  readonly type: string;
  readonly title: string;
  readonly position: {
    readonly parent: string | undefined;
    readonly order: number;
  };
  readonly fields: Readonly<Record<string, unknown>>;
  readonly meta: Readonly<Record<string, unknown>> | undefined;
}

const fieldSchemas = {
  type: z.string().min(1),
  title: z.string(),
  position: positionSchema,
  fields: record,
  meta: record.nullable(),
} as const;

export function readFieldValue<F extends EntryField>(
  conflict: MergeConflict & { readonly kind: "entry" },
  field: F,
  value: unknown,
): FieldValues[F] {
  const parsed = fieldSchemas[field].safeParse(value);
  if (!parsed.success) {
    throw invalid(
      conflict,
      `is not a valid "${field}": ${parsed.error.message}`,
    );
  }
  const data: unknown = parsed.data;
  if (field === "position") {
    const position = positionSchema.parse(data);
    return {
      parent: position.parent ?? undefined,
      order: position.order,
    } as FieldValues[F];
  }
  return (data ?? undefined) as FieldValues[F];
}
