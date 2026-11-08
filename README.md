<p align="center">
  <a href="https://docleus.io"><img src="./.github/assets/docleus.svg" width="88" alt="Docleus logo" /></a>
</p>

<h1 align="center">Docleus Core</h1>

<p align="center">
  <strong>Small core. Open extension points.</strong><br />
  Kernel, TypeScript SDK, core services, and browser host.
</p>

<p align="center">
  <a href="LICENSE"><img alt="MIT license" src="https://img.shields.io/badge/license-MIT-111111?style=flat-square" /></a>
  <img alt="Public preview in preparation" src="https://img.shields.io/badge/preview-0.0.5-cfcfcf?style=flat-square" />
  <img alt="TypeScript" src="https://img.shields.io/badge/TypeScript-strict-3178c6?style=flat-square" />
  <a href="https://docleus.io"><img alt="Online documentation" src="https://img.shields.io/badge/docs-docleus.io-111111?style=flat-square" /></a>
</p>

<p align="center">
  <a href="https://docleus.io">Documentation</a> &middot;
  <a href="#development">Development</a> &middot;
  <a href="https://github.com/Docleus/docleus">Run Docleus</a> &middot;
  <a href="https://github.com/Docleus/.github/blob/main/CONTRIBUTING.md">Contribute</a>
</p>

---

Docleus is an open-source, self-hosted documentation platform with GitBook-like features, built on a small core where almost everything is a plugin.

This repository contains the kernel, the plugin SDK, and the core plugins. Official plugins and the distribution live in separate repositories.

Status: preparing patch release `0.0.5`. All SDK extension points
remain experimental before 1.0. Packages are private and are developed from
side-by-side source checkouts; no npm installation is required or advertised.
See the [distribution](https://github.com/Docleus/docleus) for deployment and
the [plugin template](https://github.com/Docleus/docleus-plugin-template) for
plugin development.

## Development

Use Node.js 24 and pnpm 11.21.0 (`.nvmrc` and `packageManager`). Clone core and
the official plugin repositories into one parent directory, using their
repository names as directory names. Install core first, then the plugins
and distribution, with `pnpm install --frozen-lockfile` in each repository.
There is no pnpm workspace across repositories.

```sh
pnpm install --frozen-lockfile
pnpm check
pnpm build
pnpm exec playwright install chromium
pnpm e2e
```

`pnpm check` runs typecheck, lint, formatting, dependency boundaries, licenses,
and unit/in-process integration tests. Browser tests are separate; they need
the sibling repositories named in `tests/e2e/bundle.yaml`. Postgres coverage
requires `DOCLEUS_TEST_POSTGRES_URL` and `pnpm test:pg`.

## Core plugins

Each core ctx key has an interface in `@docleus/sdk`, a default implementation in `@docleus/core-<key>`, and a conformance suite in `@docleus/conformance` that any replacement must pass.

| ctx key         | Package                       | Provides                                                               |
| --------------- | ----------------------------- | ---------------------------------------------------------------------- |
| `storage`       | `@docleus/core-storage`       | Kysely over `node:sqlite` or Postgres, transactions, migrations        |
| `blobs`         | `@docleus/core-blobs`         | Content-addressed files with signed read tokens                        |
| `identity`      | `@docleus/core-identity`      | Users, passwords, expiring sessions, invitations, identity providers   |
| `authz`         | `@docleus/core-authz`         | Roles at instance, org and space level                                 |
| `content`       | `@docleus/core-content`       | Orgs, spaces, the content log, typed entries, revisions, projections   |
| `blocks`        | `@docleus/core-blocks`        | Block types, versioned migrations, unknown-block passthrough           |
| `markdown`      | `@docleus/core-markdown`      | Codec registry, source-preserving import and export, directories       |
| `render`        | `@docleus/core-render`        | Block renderers with safe placeholders                                 |
| `jobs`          | `@docleus/core-jobs`          | Database queue with retries and a concurrency limit                    |
| `http`          | `@docleus/core-http`          | Hono route registry with bearer/cookie auth, CSRF check, authorization |
| `installations` | `@docleus/core-installations` | Install, per-org and per-space enablement, settings, scoped dispatch   |
| `sites`         | `@docleus/core-sites`         | Published sites, immutable artifacts, rollback, static serving         |

`ctx.search` and `ctx.editor` have interfaces in the SDK but no core implementation; `docleus-plugin-search-db` and `docleus-plugin-editor` provide them. A configured plugin whose manifest `provides` a core key (currently `blobs`, as `docleus-plugin-blobs-s3` does) replaces the core provider, and services that use the key wait for the plugin.

To run a suite against your own implementation:

```ts
import {
  runConformanceSuite,
  authzConformanceSuite,
} from "@docleus/conformance";

runConformanceSuite(authzConformanceSuite, () => createMyAuthz());
```

Block plugins test their Markdown codecs with `@docleus/testing`:

```ts
import { createMarkdownRoundTrip } from "@docleus/testing";

const tool = createMarkdownRoundTrip([myCodec]);
tool.roundTrip(block); // tree -> Markdown -> tree
tool.survivesUninstall(block); // exports as the generic tag, restored on reinstall
tool.preserves(source); // an unchanged import exports byte for byte
```

Codecs are asked in registration order, except that a codec claiming a narrower form of a node's type (`code:mermaid` for a `code` node) is asked before the others. A codec's `fromBlock` can return `context.toGeneric(block)` for a block that has no Markdown form; it prints in the generic tag syntax and reads back unchanged.

Per-org enablement is dispatcher filtering: pass `await ctx.installations.scope(scope)` as the first argument of `ctx.emit` and friends, and listeners owned by a plugin that is installed but not enabled there are skipped.

## Storage

`createStorageService(ctx, location?)` opens in-memory SQLite when `location` is omitted, Postgres for `postgres://` or `postgresql://` URLs, and a SQLite file otherwise; `ctx.storage.dialect` says which. Migrations are written once for both: on Postgres, schema-builder `integer` becomes `bigint`, `blob` becomes `bytea`, and `text` uses the `"C"` collation, and int8 values come back as JS numbers. Transactions and migrations take one advisory lock, so they run one at a time across processes, as on SQLite. A read followed by a write that depends on it belongs in `ctx.storage.transaction`.

In tests, `testStorageLocation()` from `@docleus/testing` returns `undefined` (in-memory SQLite), or, when `DOCLEUS_TEST_POSTGRES_URL` names a Postgres server, the URL of a fresh database that is dropped after the test. `pnpm test:pg` runs core's tests that way.

## Running an instance

`@docleus/server` mounts the core plugins and a bundle of plugins, serves the API under `/api`, and serves the browser host `@docleus/app`. From this repository:

```bash
pnpm build
pnpm docleus serve --dev --bundle <bundle.yaml> --data <dir> --port 4000
```

A bundle is a YAML list of `{ id, plugin, config? }` rows; local plugin paths resolve from the bundle's directory. `--dev` turns on a development login where any email signs in as an instance admin. Never use it outside development.

- `--config <file>` (default `<data>/docleus.yaml`): the deployment config. It holds `data`, `database`, `bundle`, `port`, `publicUrl`, `trustProxy`, `siteCache` and `plugins`, whose rows patch bundle rows by `id`. Flags override its keys.
- `--database <path | postgres://...>` or `DOCLEUS_DATABASE_URL`: the database (default `<data>/docleus.db`).
- `--role all | web | worker` (default `all`): `web` serves HTTP without running jobs, `worker` runs jobs and projections and registers no HTTP routes. A job attempt holds a lease that its process renews; when a process dies, another one retries its jobs once the lease runs out (one minute), so handlers must tolerate running twice.
- `DOCLEUS_BLOB_SECRET` (environment, at least 32 characters): signs blob URLs. When unset, one is generated once into `<data>/blob-secret`; `web` and `worker` processes that do not share the data directory need the same `DOCLEUS_BLOB_SECRET`.
- Published sites are served through a disk cache of their blobs in `<data>/cache/blobs`, so a remote blob store such as S3 is not asked on every request. Processes may share the directory. `siteCache: { maxBytes }` in the deployment config sets its size (default 512 MiB; `0` turns it off); the least recently read entries are evicted first.
- Processes that run jobs collect unreferenced blobs once a day (`blobs/collect`): plugins mark the blobs they still reference on the `blobs/mark` event, and unmarked blobs stored more than a day ago are deleted. Site publications keep their artifacts and files; a removed site's blobs go at the next run. A blob provider without `list` is skipped.
- Before migrations run for a new platform version or a changed set of plugin versions, a SQLite database is copied with `VACUUM INTO` to `<data>/backups/docleus-<timestamp>.db`. Postgres is not backed up automatically.
- `docleus migrate` takes the same `--config`, `--bundle`, `--data` and `--database`, runs the platform and plugin migrations (with the same backup), commits every space at the current block versions, and exits without serving.
- `docleus configure --set <json>` writes `publicUrl`, `trustProxy` and plugin rows (matched by `id`; an object `config` replaces only the keys it has) into the deployment config, keeping everything else in the file, including comments. The Docker image runs it on every boot with the settings from the environment.
- A plugin whose manifest `engines.docleus` range does not include the platform version is refused at boot and at install (`plugin/engines-mismatch`).

The `docleus` repository has the Docker image, compose templates and the deployment guide.

## Installing plugins

Instance admins install plugins at runtime through the Plugins tab of the instance settings, or `POST /api/instance/plugins`, from an uploaded `npm pack` tarball, a path on the server, or `{ git, ref }` (shallow clone, built with `pnpm install --frozen-lockfile && pnpm build` when `dist/` is missing). A plugin is unpacked into `<data>/plugins/<name>@<version>/`, recorded in the deployment config as `{ name, version, source, sha256 }`, and mounted without a restart; uninstalling unmounts it the same way. Tarballs must be self-contained: server entries bundle their runtime dependencies or ship `node_modules`, and only the host modules (`@docleus/sdk` and the import map) are provided. Organizations enable installed plugins explicitly.

If recording an installation or uninstall in the database fails, the previous
runtime plugins and deployment config are restored before staged files are
removed. A failed replacement keeps the previous version's files. A failed
uninstall preserves the existing database settings through its transaction.
If restoring the runtime or config also fails, `plugin/rollback-failed` retains
the plugin files for manual recovery; this is not a transaction across the
filesystem and database.

Installation tasks check their database lease before shared mutations. A
takeover, expired lease or failed renewal stops further work with
`plugin/install-lease-lost` (HTTP 409). The stale task does not roll back the
deployment or remove plugin files, because another process may now own them.
Restart from the current deployment config and inspect retained files before
retrying. These checks cannot cancel an already running plugin callback or
filesystem/database operation; they do not provide atomic fencing across those
systems.

A runtime storage-provider handoff drains renewal first and checks ownership
again through the replacement service before writing the deployment or
installation record. It must reopen the same database with the same unexpired
lease row; switching to an unrelated database does not acquire a new lease.

## Accounts

Without `--dev`, an instance that has no users logs a one-time setup token on boot; open `/setup` and enter it to create the first instance administrator. Users sign in with a password or through identity provider plugins such as `docleus-plugin-auth-oidc`; the browser keeps an `HttpOnly` session cookie, and API clients can send the session token as a `Bearer` token instead. Cookie-authenticated writes from another site are rejected.

Roles depend on the scope and are inherited downward: instance `admin`; org `owner`, `admin` and `member` (read-only); space `admin`, `editor` and `viewer`. A space grant also allows reading its org. Org owners and admins invite people with a link, which is also emailed when SMTP is configured.

Deleting a space through the API removes its role grants before returning success. Deleting an organization also removes its grants and those of every space in it. Grants for other organizations, sibling spaces and the instance remain intact.

On startup, the server replays deletion events from the content log before registering the API, removing grants left by earlier versions. Later deletions through the content service are also replayed; their cleanup can be awaited with `ctx.content.catchUp("@docleus/server/deleted-scope-grants")`.

`docleus serve` options for accounts:

- `--public-url <url>`: the origin used in invitation links and the setup hint.
- `--trust-proxy`: trust `X-Forwarded-Proto`, `X-Forwarded-Host` and `X-Forwarded-For` from a reverse proxy. Required behind a proxy that terminates TLS, since the cross-site check compares `Origin` with the request's origin.
- `DOCLEUS_SMTP_URL` and `DOCLEUS_SMTP_FROM` (environment): send invitation email through this SMTP server.

Failed sign-ins are counted in the database, per account and address, so every web process on one database shares the limit.

## Search

`ctx.search` indexes named collections of `{ spaceId, entryId, revision, title, text, path? }` documents. Block types contribute searchable text through `text(node)` on their `BlockTypeDefinition`; `ctx.blocks.text(node)` collects it for a tree. `docleus-plugin-search-db` keeps the collection `main` (the head of every space's `main`) and `site:<siteId>` (the active publication of each site) as projections, and serves `GET /api/orgs/<org>/search?q=&space=`, editor command-palette search, and site-relative `_search?q=` on published sites. Static exports have no search.

## Collaboration

`ctx.http.upgrade(path, handler, options)` registers a WebSocket upgrade handler with the same authentication, cross-site check (upgrades count as unsafe), `authorize` and `public` options as routes; a refusal is written to the socket as a bare HTTP status. Site domains never upgrade. `ctx.editor.registerCollaboration(provider)` lets a plugin turn a page into a shared editing session; the first provider that returns a session wins, and the editor sends an `EditorSchemaDescription` so the server needs no ProseMirror schema. `docleus-plugin-collab` provides it with Hocuspocus on `/api/collab`.

## Branches and merge

Every space has a `main` branch; `ctx.content.createBranch` starts another one at a `main` revision, which it records as the branch's `base`. `commit` and `head` take an optional `branch` (default `main`), and revisions record their branch, their author and, for merges, the merged branch head. A commit with `rebase: <main revision>` moves a branch's base in the same transaction. Sites, search and other projections read `main` only.

`ctx.content.merge({ base, ours, theirs, resolutions })` is a pure three-way merge of entry sets, where `ours` is the target and `theirs` the branch. It merges per entry and field, and within bodies per block id (content, position and deletion); the page tree is merged and repaired so the result is always a valid tree. Where both sides changed the same thing differently, the result keeps `ours` and reports a conflict with a stable id; pass `{ take: "ours" | "theirs" }` or `{ value }` for that id to resolve it.

Every commit runs through the `content/pre-commit` waterfall, scoped to the space: a listener rejects a commit by throwing an error whose code ends in `/commit-rejected`, or returns a changed copy of what `next()` resolved to. `ctx.content.checkCommit(input)` runs the same chain with `isDryRun: true` and commits nothing; listeners with side effects skip dry runs.

Plugins that hold edits outside the content log, such as live collaboration, listen to `content/flush` (`parallel`, scoped to the space) and commit them. Anything that reads a branch head to merge or rebase dispatches it first.

`docleus-plugin-change-requests` dispatches `change-request/checks` (`parallel`, scoped to the space) with the change request and its branch head; listeners call `report(check)` with a `MergeCheck`, and a change request merges only when every required check succeeded.

Every space and page route takes `?branch=<name>`; `GET /api/orgs/<org>/spaces/<space>/branches` lists the branches, and `GET` on a space returns the current `branch`. A branch's `head` and `base` are left out of the JSON while they are unset.

## Publishing

`ctx.sites` turns spaces into static sites. A site belongs to an org, maps one or more spaces to path prefixes, and has a theme and an optional custom domain. `publish` renders every page at the given revisions (default: each space's head), stores an immutable artifact (`/index.html` per page, `/404.html`, the site runtime under `_assets/docleus/`, and the site files of enabled plugins under `_assets/plugins/<name>@<version>/`), and makes it active. `activate` serves an earlier publication again without rebuilding it. Identical inputs give an identical artifact.

Org managers manage sites through the API; site responses include the site's `url`:

| Method and path                                         | Does                                               |
| ------------------------------------------------------- | -------------------------------------------------- |
| `GET`, `POST /api/orgs/<org>/sites`                     | List sites, create one                             |
| `PATCH`, `DELETE /api/orgs/<org>/sites/<site>`          | Change slug, name, theme, domain or spaces; delete |
| `GET`, `POST /api/orgs/<org>/sites/<site>/publications` | List publications (newest first), publish          |
| `POST /api/orgs/<org>/sites/<site>/activate`            | Serve `{ publication }` again                      |

The instance serves the active publication of each site at `/sites/<org slug>/<site slug>/`, and at every path of the site's custom domain (matched on the `Host` header). Plugins can wrap site responses with the `site/request` hook. `docleus serve --site-runtime <dir>` overrides the site runtime, which defaults to the built `@docleus/app` `dist-site/`.

To host a site elsewhere, write a publication to a directory:

```bash
pnpm docleus export --site <org slug>/<site slug> --out <dir> --data <dir> [--publication <id>]
```

It exports the active publication unless `--publication` names another, and refuses an output directory that is not empty.

## Browser host

`@docleus/app` provides routing, login, organizations and spaces, the page tree, settings pages, and `ctx.ui` for plugin `editor` entries. It loads the `editor` entry of every plugin enabled for the current space (`GET /api/orgs/<org>/spaces/<space>/frontend`); organization pages (home, settings) load those enabled in the organization (`GET /api/orgs/<org>/frontend`), and the organization list and account page those of every installed plugin. Full-page apps under `/apps` belong to no space, so opening one loads the `editor` entry of every installed plugin (`GET /api/frontend`, signed-in users only) before it looks up the app; each app's API checks access and enablement itself.

- The host serves an import map with `react`, `react/jsx-runtime`, `react-dom`, `react-dom/client`, and `@docleus/sdk`. Plugin builds keep these external.
- A manifest's `exposes` adds a plugin's own modules to the import map. Each specifier has one owner; a duplicate or a host specifier refuses boot (`plugin/expose-conflict`).
- `ctx.ui.registerSlot` fills a slot (`page.editor`, `page.header`, `page.footer`, `sidebar`, `space.bar`, `space.panel`, `space.view`, `org.home`); `registerSettingsPage` and `registerApp` add settings pages and full-page apps under `/apps/<path>`; `ctx.ui.request` calls the instance API as the signed-in user. `registerCommand` and `registerSearch` add entries to the command palette (⌘K), and `notify` shows a toast.
- Spaces open read-only at `main`. Edit switches the space to edit mode; `isEditable` and `onSaveState` on the editor props carry the mode and the save state to the top bar. The space view follows `?branch=`: slot props carry `branch` and `openBranch(name)`, and the editor gets `branch`. Before the first write to a space shown at `main`, the host asks the resolvers registered with `ctx.ui.registerEditBranch`; the first branch one returns gets the write, and the view switches to it without remounting the editor. `registerEditDraft` lets Edit resume the user's open draft instead. `docleus-plugin-change-requests` uses both to open or continue a draft change request.
- Space settings is one page: general details, plugin sections, the site of the space (publish, custom domain, history and rollback, unpublish), members, plugins, and deletion. Org settings list every space's site.
- `pnpm build` also builds the site runtime into `dist-site/` (`SITE_RUNTIME_DIR`): `runtime.js`, which mounts a page's islands, the shared modules under `vendor/`, and an `importmap.json` with paths relative to that directory. Publishing copies it into every site under `_assets/docleus/`.
- `relativeTime` and `fullTime` from `@docleus/sdk` are the one way to show when something happened (`3 hours ago`, `Yesterday`, `Oct 28`; the exact moment on hover), so the host and plugins read the same.
- `ctx.editor` is provided by docleus-plugin-editor. Its interfaces live in the SDK, with `toEditorDocument` and `fromEditorDocument`, which map block trees to ProseMirror JSON and back. Blocks without an editor type become passthrough nodes that keep the original block.

Saving a page sends `PUT /api/orgs/<org>/spaces/<space>/pages/<page>/body` with the base revision and the editor document; the server converts it to a block tree, keeps unchanged blocks as they were, and commits a new revision on the branch. The save is refused as stale (409 `api/stale-head`) only when the page's body changed since the base revision; edits elsewhere in the space and renames or moves of the page do not block it.

## Community

[Contributing](https://github.com/Docleus/.github/blob/main/CONTRIBUTING.md) &middot;
[Code of conduct](https://github.com/Docleus/.github/blob/main/CODE_OF_CONDUCT.md) &middot;
[Security](https://github.com/Docleus/.github/blob/main/SECURITY.md) &middot;
[Support](https://github.com/Docleus/.github/blob/main/SUPPORT.md)

## License

[MIT](LICENSE)
