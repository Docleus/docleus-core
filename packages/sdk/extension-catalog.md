# Extension catalog

Generated from the SDK declarations. Do not edit by hand.

## Events

| Name | Mode | Stability | Description |
| --- | --- | --- | --- |
| `blobs/mark` | parallel | experimental | Collects the blob hashes plugins still reference before blob garbage collection deletes unmarked blobs past the grace period; a throwing listener aborts it. |
| `change-request/checks` | parallel | experimental | Collects the checks of a change request's head through `report`; required checks must succeed before it merges. Filtered by the space. |
| `content/flush` | parallel | experimental | Asks plugins holding unsaved changes of a branch to commit them before it is merged or rebased; filtered by the space. |
| `content/log-appended` | emit | experimental | A durable event was appended to the content log. |
| `content/pre-commit` | waterfall | experimental | Wraps every commit before it is written, filtered by the space; throw to reject, or return a changed copy of next()'s result. |
| `jobs/dead` | emit | experimental | A job exhausted its attempts and was marked dead. |
| `render/page` | waterfall | experimental | Wraps the theme layout of a site page; returns the complete HTML document. Synchronous. |
| `site/request` | waterfall | experimental | Wraps every request a published site answers, filtered by the site's first space. |

## Services

| Name | Stability | Description |
| --- | --- | --- |
| `authz` | experimental | Role grants at instance, org and space level, and `can` checks. |
| `blobs` | experimental | Content-addressed binary storage with signed read tokens. |
| `blocks` | experimental | Block type registry with versioned migrations and unknown-block passthrough. |
| `content` | experimental | Organizations, spaces, and the append-only content log. |
| `editor` | experimental | Browser: block, inline, mark, toolbar and slash menu registration, collaboration providers, plus raw Tiptap extensions. |
| `http` | experimental | Route registry with bearer and cookie authentication, a cross-site check for cookie sessions, authorization and atomic router replacement. |
| `identity` | experimental | Users with optional passwords, expiring sessions, invitations, and identity provider registration. |
| `installations` | experimental | Plugin installation, per-org and per-space enablement, settings, scoped dispatch. |
| `jobs` | experimental | Database-backed job queue with retries and a concurrency limit. |
| `markdown` | experimental | Markdown codec: plugin syntax and block codecs, source-preserving import and export, space directories. |
| `render` | experimental | Block renderers, site themes, layout slots and generated site files, with safe placeholders for unknown blocks. |
| `search` | experimental | Full-text search over named collections of pages; provided by a search plugin. |
| `sites` | experimental | Sites, immutable publish artifacts, rollback, and serving by path or custom domain. |
| `storage` | experimental | Typed database access, transactions, and plugin-owned migrations. |
| `ui` | experimental | Browser: UI slots, settings pages, full-page apps, and authenticated instance requests. |
