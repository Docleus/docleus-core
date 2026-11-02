import {
  DocleusError,
  type Artifact,
  type Publication,
  type Site,
  type SitePublished,
} from "@docleus/sdk";
import { z } from "zod";
import type { PublicationsTable, SitesTable } from "./schema.ts";

const siteSpacesSchema = z.array(
  z.object({ spaceId: z.string().min(1), path: z.string() }),
);

const revisionsSchema = z.record(z.string(), z.string());

const configSchema = z.object({
  name: z.string(),
  theme: z.string().optional(),
  themeSettings: z.unknown().optional(),
  spaces: siteSpacesSchema,
  platformVersion: z.string(),
});

const lockfileSchema = z.array(
  z.object({
    name: z.string(),
    version: z.string(),
    manifestSha256: z.string(),
    filesSha256: z.string(),
  }),
);

const artifactSchema = z.object({
  format: z.literal(1),
  files: z.record(
    z.string(),
    z.object({
      hash: z.string(),
      type: z.string(),
      size: z.number().int().nonnegative(),
    }),
  ),
});

export const sitePublishedSchema = z.object({
  siteId: z.string(),
  publication: z.string(),
  artifact: z.string(),
  rollback: z.boolean(),
  by: z.string().optional(),
});

function parseStored<T extends z.ZodType>(
  schema: T,
  text: string,
  what: string,
): z.output<T> {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (error) {
    throw new DocleusError("sites/corrupt-record", `${what} is not JSON`, {
      cause: error,
    });
  }
  const result = schema.safeParse(data);
  if (!result.success) {
    throw new DocleusError(
      "sites/corrupt-record",
      `${what} is invalid: ${result.error.message}`,
    );
  }
  return result.data;
}

export function toSite(
  row: SitesTable,
  active: string | null | undefined,
): Site {
  return {
    id: row.id,
    orgId: row.org_id,
    slug: row.slug,
    name: row.name,
    theme: row.theme ?? undefined,
    domain: row.domain ?? undefined,
    spaces: parseStored(siteSpacesSchema, row.spaces, `site "${row.id}"`),
    active: active ?? undefined,
  };
}

export function toPublication(row: PublicationsTable): Publication {
  const what = `publication "${row.id}"`;
  const config = parseStored(configSchema, row.config, what);
  return {
    id: row.id,
    siteId: row.site_id,
    artifact: row.artifact,
    revisions: parseStored(revisionsSchema, row.revisions, what),
    config: {
      name: config.name,
      theme: config.theme,
      themeSettings: config.themeSettings,
      spaces: config.spaces,
      platformVersion: config.platformVersion,
    },
    lockfile: parseStored(lockfileSchema, row.lockfile, what),
    at: row.at,
    by: row.by ?? undefined,
  };
}

export function parseArtifact(bytes: Uint8Array, hash: string): Artifact {
  return parseStored(
    artifactSchema,
    new TextDecoder().decode(bytes),
    `artifact ${hash}`,
  );
}

export function parseSitePublished(
  payload: unknown,
): SitePublished | undefined {
  const result = sitePublishedSchema.safeParse(payload);
  if (!result.success) return undefined;
  return { ...result.data, by: result.data.by };
}

/** JSON with object keys sorted at every level, so equal values give equal bytes. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, inner: unknown) => {
    if (inner === null || typeof inner !== "object" || Array.isArray(inner)) {
      return inner;
    }
    const record = inner as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(record)
        .toSorted()
        .map((key) => [key, record[key]]),
    );
  });
}
