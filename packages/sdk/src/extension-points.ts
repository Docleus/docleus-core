import { defineEvent, defineService, type ExtensionPoint } from "./declare.ts";

/**
 * Declarations of the core services on `ctx`.
 *
 * @stability experimental
 */
export const SERVICES = {
  storage: defineService({
    name: "storage",
    stability: "experimental",
    description:
      "Typed database access, transactions, and plugin-owned migrations.",
  }),
  blobs: defineService({
    name: "blobs",
    stability: "experimental",
    description: "Content-addressed binary storage with signed read tokens.",
  }),
  identity: defineService({
    name: "identity",
    stability: "experimental",
    description:
      "Users with optional passwords, expiring sessions, invitations, and identity provider registration.",
  }),
  authz: defineService({
    name: "authz",
    stability: "experimental",
    description:
      "Role grants at instance, org and space level, and `can` checks.",
  }),
  installations: defineService({
    name: "installations",
    stability: "experimental",
    description:
      "Plugin installation, per-org and per-space enablement, settings, scoped dispatch.",
  }),
  content: defineService({
    name: "content",
    stability: "experimental",
    description: "Organizations, spaces, and the append-only content log.",
  }),
  blocks: defineService({
    name: "blocks",
    stability: "experimental",
    description:
      "Block type registry with versioned migrations and unknown-block passthrough.",
  }),
  jobs: defineService({
    name: "jobs",
    stability: "experimental",
    description:
      "Database-backed job queue with retries and a concurrency limit.",
  }),
  markdown: defineService({
    name: "markdown",
    stability: "experimental",
    description:
      "Markdown codec: plugin syntax and block codecs, source-preserving import and export, space directories.",
  }),
  render: defineService({
    name: "render",
    stability: "experimental",
    description:
      "Block renderers, site themes, layout slots and generated site files, with safe placeholders for unknown blocks.",
  }),
  sites: defineService({
    name: "sites",
    stability: "experimental",
    description:
      "Sites, immutable publish artifacts, rollback, and serving by path or custom domain.",
  }),
  http: defineService({
    name: "http",
    stability: "experimental",
    description:
      "Route registry with bearer and cookie authentication, a cross-site check for cookie sessions, authorization and atomic router replacement.",
  }),
  search: defineService({
    name: "search",
    stability: "experimental",
    description:
      "Full-text search over named collections of pages; provided by a search plugin.",
  }),
  editor: defineService({
    name: "editor",
    stability: "experimental",
    description:
      "Browser: block, inline, mark, toolbar and slash menu registration, collaboration providers, plus raw Tiptap extensions.",
  }),
  ui: defineService({
    name: "ui",
    stability: "experimental",
    description:
      "Browser: UI slots, settings pages, full-page apps, and authenticated instance requests.",
  }),
} as const;

/**
 * Declarations of the core events, with their dispatch modes.
 *
 * @stability experimental
 */
export const EVENTS = {
  contentLogAppended: defineEvent({
    name: "content/log-appended",
    mode: "emit",
    stability: "experimental",
    description: "A durable event was appended to the content log.",
  }),
  jobsDead: defineEvent({
    name: "jobs/dead",
    mode: "emit",
    stability: "experimental",
    description: "A job exhausted its attempts and was marked dead.",
  }),
  blobsMark: defineEvent({
    name: "blobs/mark",
    mode: "parallel",
    stability: "experimental",
    description:
      "Collects the blob hashes plugins still reference before blob garbage collection deletes unmarked blobs past the grace period; a throwing listener aborts it.",
  }),
  contentPreCommit: defineEvent({
    name: "content/pre-commit",
    mode: "waterfall",
    stability: "experimental",
    description:
      "Wraps every commit before it is written, filtered by the space; throw to reject, or return a changed copy of next()'s result.",
  }),
  contentFlush: defineEvent({
    name: "content/flush",
    mode: "parallel",
    stability: "experimental",
    description:
      "Asks plugins holding unsaved changes of a branch to commit them before it is merged or rebased; filtered by the space.",
  }),
  changeRequestChecks: defineEvent({
    name: "change-request/checks",
    mode: "parallel",
    stability: "experimental",
    description:
      "Collects the checks of a change request's head through `report`; required checks must succeed before it merges. Filtered by the space.",
  }),
  renderPage: defineEvent({
    name: "render/page",
    mode: "waterfall",
    stability: "experimental",
    description:
      "Wraps the theme layout of a site page; returns the complete HTML document. Synchronous.",
  }),
  siteRequest: defineEvent({
    name: "site/request",
    mode: "waterfall",
    stability: "experimental",
    description:
      "Wraps every request a published site answers, filtered by the site's first space.",
  }),
} as const;

/**
 * Every core service and event, in catalog order.
 *
 * @stability experimental
 */
export const EXTENSION_POINTS: readonly ExtensionPoint[] = [
  ...Object.values(SERVICES),
  ...Object.values(EVENTS),
];
