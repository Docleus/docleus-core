import { z } from "zod";

const ENTRY_KINDS = ["shared", "server", "editor", "site"] as const;
const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

/**
 * Schema of `docleus.plugin.json`.
 *
 * @stability experimental
 */
export const ManifestSchema = z.strictObject({
  name: z.string().min(1),
  version: z.string().regex(VERSION, "expected a semantic version"),
  engines: z.strictObject({ docleus: z.string().min(1) }),
  entries: z
    .strictObject({
      shared: z.string().min(1).optional(),
      server: z.string().min(1).optional(),
      editor: z.string().min(1).optional(),
      site: z.string().min(1).optional(),
    })
    .refine(
      (entries) => ENTRY_KINDS.some((kind) => entries[kind] !== undefined),
      {
        message: "at least one entry is required",
      },
    ),
  requires: z.array(z.string().min(1)).default([]),
  provides: z.array(z.string().min(1)).default([]),
  syntax: z.array(z.string().min(1)).default([]),
  /**
   * Browser modules this plugin adds to the host import map: a bare
   * specifier mapped to a file path relative to the plugin directory.
   */
  exposes: z.record(z.string().min(1), z.string().min(1)).default({}),
  /**
   * Browser modules of interactive blocks on published sites: a block type
   * mapped to a file path relative to the plugin directory. The module
   * exports `mount(element, props)`.
   */
  islands: z.record(z.string().min(1), z.string().min(1)).default({}),
});

/**
 * A parsed plugin manifest, with defaults applied.
 *
 * @stability experimental
 */
export type Manifest = z.output<typeof ManifestSchema>;
/**
 * A plugin manifest as written in `docleus.plugin.json`.
 *
 * @stability experimental
 */
export type ManifestInput = z.input<typeof ManifestSchema>;
/**
 * The entries a plugin can have: `shared`, `server`, `editor` and `site`.
 *
 * @stability experimental
 */
export type EntryKind = (typeof ENTRY_KINDS)[number];

/**
 * Parses a plugin manifest. Throws a zod error when it is invalid.
 *
 * @stability experimental
 */
export function parseManifest(data: unknown): Manifest {
  return ManifestSchema.parse(data);
}

/**
 * A Markdown syntax claimed by more than one manifest.
 *
 * @stability experimental
 */
export interface SyntaxConflict {
  readonly syntax: string;
  /** Names of the manifests that claim it. */
  readonly plugins: readonly string[];
}

/**
 * Syntax claimed by more than one manifest. Installing a set of plugins
 * with any conflict must fail, since only one of them can own the syntax.
 */
export function findSyntaxConflicts(
  manifests: readonly Pick<Manifest, "name" | "syntax">[],
): SyntaxConflict[] {
  const owners = new Map<string, string[]>();
  for (const manifest of manifests) {
    for (const syntax of new Set(manifest.syntax)) {
      owners.set(syntax, [...(owners.get(syntax) ?? []), manifest.name]);
    }
  }
  return [...owners]
    .filter(([, plugins]) => plugins.length > 1)
    .map(([syntax, plugins]) => ({ syntax, plugins }));
}

/**
 * An import map specifier exposed by more than one manifest.
 *
 * @stability experimental
 */
export interface ExposeConflict {
  readonly specifier: string;
  /** Names of the manifests that expose it. */
  readonly plugins: readonly string[];
}

/**
 * Import map specifiers exposed by more than one manifest. The host can
 * map a specifier to only one module, so such a set must not boot.
 */
export function findExposeConflicts(
  manifests: readonly Pick<Manifest, "name" | "exposes">[],
): ExposeConflict[] {
  const owners = new Map<string, string[]>();
  for (const manifest of manifests) {
    for (const specifier of Object.keys(manifest.exposes)) {
      owners.set(specifier, [...(owners.get(specifier) ?? []), manifest.name]);
    }
  }
  return [...owners]
    .filter(([, plugins]) => plugins.length > 1)
    .map(([specifier, plugins]) => ({ specifier, plugins }));
}

/**
 * A block type with an island module in more than one manifest.
 *
 * @stability experimental
 */
export interface IslandConflict {
  readonly type: string;
  /** Names of the manifests that declare an island for it. */
  readonly plugins: readonly string[];
}

/** Block types with an island module in more than one manifest. */
export function findIslandConflicts(
  manifests: readonly Pick<Manifest, "name" | "islands">[],
): IslandConflict[] {
  const owners = new Map<string, string[]>();
  for (const manifest of manifests) {
    for (const type of Object.keys(manifest.islands)) {
      owners.set(type, [...(owners.get(type) ?? []), manifest.name]);
    }
  }
  return [...owners]
    .filter(([, plugins]) => plugins.length > 1)
    .map(([type, plugins]) => ({ type, plugins }));
}

type Triple = readonly [number, number, number];

interface Parsed {
  readonly triple: Triple;
  /** How many leading components are concrete: `1.x` → 1, `1.2.3` → 3. */
  readonly parts: number;
}

interface Bound {
  readonly triple: Triple;
  readonly isInclusive: boolean;
}

interface Interval {
  readonly lower?: Bound;
  readonly upper?: Bound;
}

const COMPARATOR = /^(\^|~|>=|<=|>|<|=)?v?(.*)$/;

function parseVersion(text: string): Parsed | undefined {
  const match = /^(\d+)(?:\.(\d+))?(?:\.(\d+))?$/.exec(text);
  if (!match) return undefined;
  return {
    triple: [Number(match[1]), Number(match[2] ?? 0), Number(match[3] ?? 0)],
    parts: match[3] !== undefined ? 3 : match[2] !== undefined ? 2 : 1,
  };
}

/** Parses a possibly partial version where `x`, `X` or `*` end the concrete part. */
function parsePartial(text: string): Parsed | undefined {
  const components = text.split(".");
  if (components.length > 3) return undefined;
  const numbers: number[] = [];
  let isWild = false;
  for (const component of components) {
    if (component === "x" || component === "X" || component === "*") {
      isWild = true;
    } else if (/^\d+$/.test(component) && !isWild) {
      numbers.push(Number(component));
    } else {
      return undefined;
    }
  }
  return {
    triple: [numbers[0] ?? 0, numbers[1] ?? 0, numbers[2] ?? 0],
    parts: numbers.length,
  };
}

function compare(a: Triple, b: Triple): number {
  for (let i = 0; i < 3; i++) {
    const diff = (a[i] ?? 0) - (b[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/** The smallest version above every version that shares `base` on `0..index`. */
function bump(base: Triple, index: number): Triple {
  const next = [0, 0, 0];
  for (let i = 0; i < index; i++) next[i] = base[i] ?? 0;
  next[index] = (base[index] ?? 0) + 1;
  return [next[0] ?? 0, next[1] ?? 0, next[2] ?? 0];
}

function from(triple: Triple, isInclusive = true): Bound {
  return { triple, isInclusive };
}

function toInterval(operator: string, version: Parsed): Interval | undefined {
  const { triple, parts } = version;
  switch (operator) {
    case "=":
      if (parts === 0) return {};
      if (parts === 3) return { lower: from(triple), upper: from(triple) };
      return {
        lower: from(triple),
        upper: from(bump(triple, parts - 1), false),
      };
    case "~":
      if (parts === 0) return {};
      return {
        lower: from(triple),
        upper: from(bump(triple, parts === 1 ? 0 : 1), false),
      };
    case "^": {
      if (parts === 0) return {};
      // `^` locks everything up to the first non-zero written component.
      let last = parts - 1;
      for (let i = 0; i < parts; i++) {
        if (triple[i] !== 0) {
          last = i;
          break;
        }
      }
      return { lower: from(triple), upper: from(bump(triple, last), false) };
    }
    case ">=":
      return parts === 0 ? {} : { lower: from(triple) };
    case ">":
      if (parts === 0) return undefined;
      if (parts === 3) return { lower: from(triple, false) };
      return { lower: from(bump(triple, parts - 1)) };
    case "<":
      if (parts === 0) return undefined;
      return { upper: from(triple, false) };
    case "<=":
      if (parts === 0) return {};
      if (parts === 3) return { upper: from(triple) };
      return { upper: from(bump(triple, parts - 1), false) };
    default:
      return undefined;
  }
}

function contains(interval: Interval, actual: Triple): boolean {
  const { lower, upper } = interval;
  if (lower) {
    const diff = compare(actual, lower.triple);
    if (diff < 0 || (diff === 0 && !lower.isInclusive)) return false;
  }
  if (upper) {
    const diff = compare(actual, upper.triple);
    if (diff > 0 || (diff === 0 && !upper.isInclusive)) return false;
  }
  return true;
}

/** Splits a comparator set on whitespace, joining an operator written apart from its version. */
function comparators(set: string): string[] | undefined {
  const tokens = set.trim().split(/\s+/).filter(Boolean);
  const joined: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i] ?? "";
    if (/^(\^|~|>=|<=|>|<|=)$/.test(token)) {
      const next = tokens[i + 1];
      if (next === undefined) return undefined;
      joined.push(token + next);
      i++;
    } else {
      joined.push(token);
    }
  }
  return joined.length > 0 ? joined : undefined;
}

function satisfiesSet(actual: Triple, set: string): boolean {
  const parts = comparators(set);
  if (!parts) return false;
  return parts.every((part) => {
    const match = COMPARATOR.exec(part);
    const version = match ? parsePartial(match[2] ?? "") : undefined;
    const interval =
      match && version ? toInterval(match[1] ?? "=", version) : undefined;
    return interval !== undefined && contains(interval, actual);
  });
}

/**
 * Checks a release `version` (`x.y.z`) against an npm-style range: exact or
 * partial versions, `x`/`X`/`*` wildcards, `^`, `~`, `>`, `>=`, `<`, `<=`,
 * `=`, space-separated comparators (all must hold) and `||` alternatives.
 * Prerelease tags and hyphen ranges are not supported and never match.
 */
export function satisfiesRange(version: string, range: string): boolean {
  const actual = parseVersion(version);
  if (!actual || actual.parts !== 3) return false;
  return range.split("||").some((set) => satisfiesSet(actual.triple, set));
}
