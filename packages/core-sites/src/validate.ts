import { DocleusError, type SiteSpace } from "@docleus/sdk";

const SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
const LABEL = "[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?";
const HOST_PATTERN = new RegExp(`^${LABEL}(?:\\.${LABEL})*$`);
const MAX_HOST_LENGTH = 253;
const PATH_SEGMENT = "[a-z0-9](?:[a-z0-9-]*[a-z0-9])?";
const PATH_PATTERN = new RegExp(`^${PATH_SEGMENT}(?:/${PATH_SEGMENT})*$`);

export function assertSlug(slug: string): void {
  if (!SLUG_PATTERN.test(slug)) {
    throw new DocleusError("sites/invalid-slug", `invalid slug "${slug}"`);
  }
}

export function assertName(name: string): void {
  if (name.trim() === "") {
    throw new DocleusError("sites/invalid-name", "a site needs a name");
  }
}

/** A lowercase host name without port or trailing dot, or `undefined` when `host` is not one. */
export function normalizeHost(host: string): string | undefined {
  let name = host.trim().toLowerCase();
  const colon = name.lastIndexOf(":");
  if (colon >= 0) {
    if (!/^\d*$/.test(name.slice(colon + 1))) return undefined;
    name = name.slice(0, colon);
  }
  if (name.endsWith(".")) name = name.slice(0, -1);
  if (name.length > MAX_HOST_LENGTH || !HOST_PATTERN.test(name)) {
    return undefined;
  }
  return name;
}

export function parseDomain(domain: string): string {
  const normalized = normalizeHost(domain);
  if (normalized === undefined) {
    throw new DocleusError(
      "sites/invalid-domain",
      `"${domain}" is not a host name`,
    );
  }
  return normalized;
}

/** Checks the shape of the list; whether the spaces exist is checked against storage. */
export function assertSpaces(spaces: readonly SiteSpace[]): void {
  if (spaces.length === 0) {
    throw new DocleusError(
      "sites/invalid-spaces",
      "a site needs at least one space",
    );
  }
  const ids = new Set<string>();
  const paths = new Set<string>();
  for (const { spaceId, path } of spaces) {
    if (ids.has(spaceId)) {
      throw new DocleusError(
        "sites/invalid-spaces",
        `space "${spaceId}" is listed twice`,
      );
    }
    ids.add(spaceId);
    if (path !== "" && !PATH_PATTERN.test(path)) {
      throw new DocleusError(
        "sites/invalid-path",
        `"${path}" is not a site path: use "" or lowercase segments separated by "/"`,
      );
    }
    if (paths.has(path)) {
      throw new DocleusError(
        "sites/invalid-path",
        `two spaces use the path "${path}"`,
      );
    }
    paths.add(path);
  }
}
