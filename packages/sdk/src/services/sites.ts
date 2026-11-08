/** A space published as part of a site. */
export interface SiteSpace {
  readonly spaceId: string;
  /**
   * Site-relative prefix the space's pages live under: `""` for the site
   * root, otherwise lowercase segments separated by `/`, such as `api`.
   */
  readonly path: string;
}

/**
 * A published site: one or more spaces of an org under a slug and an optional domain.
 */
export interface Site {
  readonly id: string;
  readonly orgId: string;
  /** Unique within the org; the site is served at `/sites/<org slug>/<slug>/`. */
  readonly slug: string;
  readonly name: string;
  /** The theme name; the first registered theme when `undefined`. */
  readonly theme: string | undefined;
  /** A lowercase host name without a port, unique across the instance. */
  readonly domain: string | undefined;
  /** At least one, with distinct spaces and distinct paths. */
  readonly spaces: readonly SiteSpace[];
  /** The publication being served, or `undefined` before the first publish. */
  readonly active: string | undefined;
}

/** Input of `sites.create`. */
export interface CreateSiteInput {
  readonly orgId: string;
  readonly slug: string;
  readonly name: string;
  readonly theme?: string;
  readonly domain?: string;
  readonly spaces: readonly SiteSpace[];
}

/** Fields to change; `null` clears an optional field. */
export interface UpdateSiteInput {
  readonly slug?: string;
  readonly name?: string;
  readonly theme?: string | null;
  readonly domain?: string | null;
  readonly spaces?: readonly SiteSpace[];
}

/** A plugin as it was when a site was published. */
export interface PluginLock {
  readonly name: string;
  readonly version: string;
  /** SHA-256 of the plugin's `docleus.plugin.json`. */
  readonly manifestSha256: string;
  /** SHA-256 over the paths and contents of the browser files copied into the artifact. */
  readonly filesSha256: string;
}

/** The site configuration a publication was built from. */
export interface SiteConfigSnapshot {
  readonly name: string;
  readonly theme: string | undefined;
  readonly themeSettings: unknown;
  readonly spaces: readonly SiteSpace[];
  readonly platformVersion: string;
}

/** A file of a published artifact, stored as a blob. */
export interface ArtifactFile {
  /** Blob hash of the file's bytes. */
  readonly hash: string;
  readonly type: string;
  readonly size: number;
}

/**
 * A published site, stored as a canonical JSON blob: identical inputs give
 * an identical blob, and artifacts never change once written.
 */
export interface Artifact {
  readonly format: 1;
  /** Keyed by site-relative path, such as `/guide/index.html`. */
  readonly files: Readonly<Record<string, ArtifactFile>>;
}

/**
 * One publish of a site: the artifact, and the revisions, config and plugins it was built from.
 */
export interface Publication {
  readonly id: string;
  readonly siteId: string;
  /** Blob hash of the {@link Artifact}. */
  readonly artifact: string;
  /** The revision published, keyed by space id. */
  readonly revisions: Readonly<Record<string, string>>;
  readonly config: SiteConfigSnapshot;
  /** Every plugin enabled in the published spaces, sorted by name. */
  readonly lockfile: readonly PluginLock[];
  readonly at: number;
  /** The user who published, when known. */
  readonly by: string | undefined;
}

/** The content-log type written when a site starts serving a publication. */
export const SITE_PUBLISHED = "site/published";

/** Payload of a {@link SITE_PUBLISHED} log entry. */
export interface SitePublished {
  readonly siteId: string;
  readonly publication: string;
  readonly artifact: string;
  /** Set when an older publication was made active again. */
  readonly rollback: boolean;
  readonly by: string | undefined;
}

/** What a `site/request` hook sees. */
export interface SiteRequest {
  readonly request: Request;
  readonly site: Site;
  readonly publication: Publication | undefined;
  /** The site-relative path, decoded, starting with `/`. */
  readonly path: string;
}

/**
 * Sites, their publications, and serving the active publication.
 *
 * @stability experimental
 */
export interface SitesService {
  /** Rejects a taken slug or domain, unknown spaces, and spaces of another org. */
  create(input: CreateSiteInput): Promise<Site>;
  get(id: string): Promise<Site | undefined>;
  list(orgId: string): Promise<Site[]>;
  update(id: string, input: UpdateSiteInput): Promise<Site>;
  /** Deletes the site and its publication records; blob garbage collection removes its artifacts later. */
  remove(id: string): Promise<void>;
  /** `host` may carry a port and any case. */
  findByDomain(host: string): Promise<Site | undefined>;
  findBySlug(orgSlug: string, siteSlug: string): Promise<Site | undefined>;

  /**
   * Renders every page of the site's spaces at `revisions` (default: each
   * space's main head). Explicit revisions must belong to that space's
   * main branch; older main revisions remain valid. Stores the artifact,
   * records the publication, and makes
   * it active by appending {@link SITE_PUBLISHED}. Publishes of one site
   * run one at a time.
   */
  publish(
    siteId: string,
    options?: {
      readonly revisions?: Readonly<Record<string, string>>;
      readonly by?: string;
    },
  ): Promise<Publication>;
  /** Newest first. */
  listPublications(siteId: string): Promise<Publication[]>;
  getPublication(id: string): Promise<Publication | undefined>;
  /** Serves an earlier publication again, without rebuilding it. */
  activate(
    siteId: string,
    publicationId: string,
    options?: { readonly by?: string },
  ): Promise<void>;
  readArtifact(hash: string): Promise<Artifact>;
  /**
   * Answers a request for site-relative `path` from the active
   * publication, inside the `site/request` waterfall.
   */
  serve(site: Site, request: Request, path: string): Promise<Response>;
}
