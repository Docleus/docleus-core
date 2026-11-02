import { parse, stringify } from "yaml";
import { z } from "zod";
import { DocleusError } from "../errors.ts";
import {
  ConfigPatchRowSchema,
  ConfigRowSchema,
  type ConfigPatchRow,
  type ConfigRow,
} from "./schema.ts";

export interface ConfigLayers {
  bundle: readonly ConfigRow[];
  profile?: readonly ConfigPatchRow[];
  deployment?: readonly ConfigPatchRow[];
  overlays?: readonly (readonly ConfigPatchRow[])[];
}

function parseRows<T>(source: string, text: string, schema: z.ZodType<T>): T[] {
  let data: unknown;
  try {
    data = parse(text) ?? [];
  } catch (error) {
    throw new DocleusError("config/invalid-yaml", `${source}: invalid YAML`, {
      cause: error,
    });
  }
  const result = z.array(schema).safeParse(data);
  if (!result.success) {
    const details = result.error.issues
      .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("; ");
    throw new DocleusError("config/invalid-layer", `${source}: ${details}`);
  }
  return result.data;
}

function assertUniqueIds(
  source: string,
  rows: readonly { id: string }[],
): void {
  const seen = new Set<string>();
  for (const row of rows) {
    if (seen.has(row.id)) {
      throw new DocleusError(
        "config/duplicate-id",
        `${source}: duplicate row id "${row.id}"`,
      );
    }
    seen.add(row.id);
  }
}

export function parseBundle(source: string, text: string): ConfigRow[] {
  const rows = parseRows(source, text, ConfigRowSchema);
  assertUniqueIds(source, rows);
  return rows;
}

export function parsePatch(source: string, text: string): ConfigPatchRow[] {
  const rows = parseRows(source, text, ConfigPatchRowSchema);
  assertUniqueIds(source, rows);
  return rows;
}

export function applyPatch(
  rows: readonly ConfigRow[],
  patch: readonly ConfigPatchRow[],
  source = "patch",
): ConfigRow[] {
  const result = [...rows];
  for (const row of patch) {
    const index = result.findIndex((existing) => existing.id === row.id);
    if (index >= 0) {
      result[index] = { ...result[index], ...row } as ConfigRow;
      continue;
    }
    if (row.plugin === undefined) {
      throw new DocleusError(
        "config/missing-plugin",
        `${source}: row "${row.id}" does not exist and has no "plugin" to append`,
      );
    }
    result.push({ ...row, plugin: row.plugin });
  }
  return result;
}

export function composeConfig(layers: ConfigLayers): ConfigRow[] {
  assertUniqueIds("bundle", layers.bundle);
  let rows = [...layers.bundle];
  const patches: [string, readonly ConfigPatchRow[]][] = [
    ["profile", layers.profile ?? []],
    ["deployment", layers.deployment ?? []],
    ...(layers.overlays ?? []).map(
      (overlay, i): [string, readonly ConfigPatchRow[]] => [
        `overlay ${i + 1}`,
        overlay,
      ],
    ),
  ];
  for (const [source, patch] of patches) rows = applyPatch(rows, patch, source);
  return rows;
}

export function dumpConfig(rows: readonly ConfigRow[]): string {
  return stringify(
    rows.map((row) => ({ ...row })),
    { lineWidth: 0 },
  );
}
