import type {
  AuthzService,
  BlobsService,
  BlocksService,
  ContentService,
  EditorService,
  HttpService,
  IdentityService,
  InstallationsService,
  JobsService,
  MarkdownService,
  RenderService,
  SearchService,
  SitesService,
  StorageService,
  UiService,
} from "./services/index.ts";

declare module "@docleus/kernel" {
  interface Context {
    storage: StorageService;
    blobs: BlobsService;
    identity: IdentityService;
    authz: AuthzService;
    installations: InstallationsService;
    content: ContentService;
    blocks: BlocksService;
    jobs: JobsService;
    markdown: MarkdownService;
    render: RenderService;
    sites: SitesService;
    http: HttpService;
    /** Provided by a search plugin such as `docleus-plugin-search-db`; absent otherwise. */
    search: SearchService;
    /** Browser only: provided by the editor plugin's `editor` entry. */
    editor: EditorService;
    /** Browser only: provided by `@docleus/app`. */
    ui: UiService;
  }

  interface Events {
    /**
     * A durable event was appended to the content log.
     *
     * @mode emit
     * @stability experimental
     */
    "content/log-appended"(
      entry: import("./services/content.ts").LogEntry,
    ): void;
    /**
     * A job exhausted its attempts and was marked dead.
     *
     * @mode emit
     * @stability experimental
     */
    "jobs/dead"(job: import("./services/jobs.ts").Job, error: unknown): void;
    /**
     * Collects the blobs still in use before blob garbage collection
     * deletes the others. Every plugin that keeps blob hashes (in its
     * tables, in other blobs, anywhere) calls `input.mark` for each of
     * them; an unmarked blob is deleted once it is older than the grace
     * period. A listener that throws aborts the collection.
     *
     * @mode parallel
     * @stability experimental
     */
    "blobs/mark"(
      input: import("./services/blobs.ts").BlobMarkInput,
    ): Promise<void>;
    /**
     * Runs before a commit is written; the value the chain resolves to is
     * what gets committed. Return `next()` to let it through, a changed
     * copy of what `next()` resolved to to rewrite it, or throw a
     * `DocleusError` whose code ends in `/commit-rejected` to reject it.
     *
     * @mode waterfall
     * @stability experimental
     */
    "content/pre-commit"(
      input: import("./services/content.ts").PreCommitInput,
      next: () => Promise<import("./services/content.ts").PreCommitInput>,
    ): Promise<import("./services/content.ts").PreCommitInput>;
    /**
     * Asks plugins that hold unsaved changes of a branch (such as a shared
     * editing session) to commit them now. Dispatched, filtered by the
     * space, before something reads a branch head to merge or rebase it.
     *
     * @mode parallel
     * @stability experimental
     */
    "content/flush"(
      input: import("./services/content.ts").ContentFlushInput,
    ): Promise<void>;
    /**
     * Collects the checks of a change request before it is shown or
     * merged, filtered by the space. Listeners call `input.report` for each
     * check of `input.head`; a change request merges only when every
     * required check reports `success`. A listener that throws counts as a
     * failed required check.
     *
     * @mode parallel
     * @stability experimental
     */
    "change-request/checks"(
      input: import("./services/content.ts").ChangeRequestChecksInput,
    ): Promise<void>;
    /**
     * @mode waterfall
     * @stability experimental
     */
    "render/page"(
      input: import("./services/render.ts").SiteLayoutInput,
      next: () => string,
    ): string;
    /**
     * @mode waterfall
     * @stability experimental
     */
    "site/request"(
      input: import("./services/sites.ts").SiteRequest,
      next: () => Promise<Response>,
    ): Promise<Response>;
  }
}
