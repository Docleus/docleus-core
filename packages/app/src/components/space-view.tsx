import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import {
  MAIN_BRANCH,
  type Branch,
  type Org,
  type SaveState,
  type Space,
  type SpaceBarProps,
} from "@docleus/sdk";
import { ApiError, api } from "../lib/api.ts";
import { createEditBranchGate } from "../lib/edit-branch.ts";
import { asComponent, useHost, useSlot, useUiVersion } from "../lib/host.tsx";
import type { PageSummary } from "../lib/page-tree.ts";
import {
  navigate,
  switchBranch,
  useBranch,
  useSearchParams,
  withBranch,
  withParams,
} from "../lib/router.ts";
import { useLoad } from "../lib/use-load.ts";
import { ReportedError, fireWrite } from "../lib/write.ts";
import { usePlugins } from "../lib/use-plugins.ts";
import { ErrorView } from "./error-view.tsx";
import { Frame, SideLabel } from "./frame.tsx";
import { Menu, MenuItem, anchorOf, useLayer } from "./layers.tsx";
import { Link } from "./link.tsx";
import { PageTree, type TreeWrite } from "./page-tree.tsx";
import { PageView } from "./page-view.tsx";
import type { PaletteCommand } from "./palette.tsx";
import { SiteControls, isAhead, useSiteStatus } from "./publish.tsx";
import { Redirect } from "./redirect.tsx";
import { SpaceSettings } from "./space-settings.tsx";

interface SpaceData {
  readonly space: Space;
  readonly branch: Branch;
  readonly head: string | null;
  readonly editedAt: number | null;
  readonly pages: PageSummary[];
  readonly canWrite: boolean;
}

const SAVE_LABELS: Readonly<Record<SaveState["kind"], string>> = {
  saved: "Saved",
  dirty: "Unsaved",
  saving: "Saving…",
  error: "Save failed",
};

function ancestors(pages: readonly PageSummary[], id: string): PageSummary[] {
  const out: PageSummary[] = [];
  let current = pages.find((page) => page.id === id);
  while (current?.parent) {
    const parent = pages.find((page) => page.id === current?.parent);
    if (!parent) break;
    out.unshift(parent);
    current = parent;
  }
  return out;
}

/**
 * A space: the page tree on the left, the top bar, and the page, read-only
 * at `main` until Edit (docs/decisions/0013). Edit resumes the user's draft
 * when a plugin finds one; otherwise the first write picks the edit branch
 * through the resolvers. A branch other than `main` is always edit mode.
 */
export function SpaceView(props: {
  orgId: string;
  spaceId: string;
  pageId?: string;
  settings?: string;
}) {
  const { orgId, spaceId } = props;
  const { ui } = useHost();
  const branch = useBranch();
  const params = useSearchParams();
  const view = params.get("view") ?? undefined;
  const panel = params.get("panel") ?? undefined;
  const base = `/orgs/${orgId}/spaces/${spaceId}`;
  const apiBase = `/api${base}`;
  const [treeVersion, setTreeVersion] = useState(0);
  const [siteVersion, setSiteVersion] = useState(0);
  const space = useLoad(`${apiBase}?${branch}#${treeVersion}`, () =>
    api<SpaceData>("GET", withBranch(apiBase, branch)),
  );
  const main = useLoad(`${apiBase}?main#${treeVersion}`, () =>
    branch === MAIN_BRANCH
      ? Promise.resolve(undefined)
      : api<SpaceData>("GET", apiBase),
  );
  const plugins = usePlugins(`${apiBase}/frontend`);
  const org = useLoad(`org/${orgId}`, () =>
    api<{ org: Org }>("GET", `/api/orgs/${orgId}`),
  );
  const site = useSiteStatus(orgId, spaceId, siteVersion + treeVersion);
  const uiVersion = useUiVersion();
  const draft = useLoad(
    `draft/${orgId}/${spaceId}/${uiVersion}#${treeVersion}@${branch}`,
    () => ui.findEditDraft({ orgId, spaceId }),
  );
  const [saveState, setSaveState] = useState<SaveState | undefined>();
  const [stopTasks] = useState(() => new Set<() => Promise<void>>());
  const onStopEditing = useCallback(
    (task: () => Promise<void>) => {
      stopTasks.add(task);
      return () => {
        stopTasks.delete(task);
      };
    },
    [stopTasks],
  );
  const [isLeaving, setIsLeaving] = useState(false);
  const bar = useSlot("space.bar");
  const views = useSlot("space.view");
  const panels = useSlot("space.panel");
  const sidebar = useSlot("sidebar");
  const spaceMenu = useLayer();

  const [gate] = useState(() =>
    createEditBranchGate({
      branch,
      resolve: (entryId) => ui.resolveEditBranch({ orgId, spaceId, entryId }),
      switchTo: (name) =>
        navigate(
          withParams(location.pathname, location.search, {
            branch: name === MAIN_BRANCH ? null : name,
            edit: null,
          }),
          { replace: true },
        ),
    }),
  );
  useEffect(() => gate.setShown(branch), [gate, branch]);
  // Resolvers of plugins enabled during the visit get their turn.
  useEffect(() => gate.forget(), [gate, uiVersion]);

  const canWrite = space.data?.canWrite ?? false;
  const isEditing =
    canWrite && (branch !== MAIN_BRANCH || params.get("edit") === "1");
  useEffect(() => {
    if (!isEditing) setSaveState(undefined);
  }, [isEditing]);

  const openBranch = useCallback(
    (name: string) =>
      navigate(switchBranch(location.pathname, location.search, name)),
    [],
  );
  const refresh = useCallback(() => setTreeVersion((n) => n + 1), []);
  const write: TreeWrite = useCallback(
    async (entryId, action) => {
      try {
        const result = await gate.write(entryId, action);
        refresh();
        return result;
      } catch (error) {
        ui.notify({
          message: error instanceof Error ? error.message : "The change failed",
        });
        throw new ReportedError(error);
      }
    },
    [gate, refresh, ui],
  );
  const pageHref = (id: string, target = branch) =>
    withBranch(`${base}/pages/${id}`, target);
  const openNew = (pageId: string, target: string) =>
    navigate(
      target === MAIN_BRANCH
        ? `${base}/pages/${pageId}?edit=1`
        : pageHref(pageId, target),
    );

  const startEditing = () => {
    const found = draft.data;
    const at =
      props.pageId === undefined ? base : `${base}/pages/${props.pageId}`;
    if (found) navigate(withBranch(at, found.branch));
    else
      navigate(withParams(location.pathname, location.search, { edit: "1" }));
  };
  const stopEditing = useCallback(() => {
    const at =
      props.pageId === undefined ? base : `${base}/pages/${props.pageId}`;
    navigate(at);
    setIsLeaving(false);
  }, [base, props.pageId]);
  // Done: the plugins' tasks first (a failing one is reported, not fatal).
  const isFinishing = useRef(false);
  const finishEditing = useCallback(async () => {
    if (isFinishing.current) return;
    isFinishing.current = true;
    const results = await Promise.allSettled(
      [...stopTasks].map((task) => task()),
    );
    for (const result of results) {
      if (result.status === "rejected") {
        ui.notify({
          message:
            result.reason instanceof Error
              ? result.reason.message
              : "Leaving edit mode failed",
        });
      }
    }
    isFinishing.current = false;
    stopEditing();
    refresh();
  }, [stopTasks, stopEditing, ui, refresh]);
  // Done waits for a save in flight, so the save does not switch the view back.
  const done = () => {
    setIsLeaving(true);
    if (saveState?.kind === "dirty" || saveState?.kind === "saving") {
      // Blurring the editor saves it; the effect below finishes after.
      (document.activeElement as HTMLElement | null)?.blur();
    } else {
      void finishEditing();
    }
  };
  useEffect(() => {
    if (
      isLeaving &&
      (saveState?.kind === "saved" || saveState?.kind === "error")
    ) {
      void finishEditing();
    }
  }, [isLeaving, saveState, finishEditing]);
  const openView = useCallback(
    (id: string | undefined) =>
      navigate(
        withParams(location.pathname, location.search, { view: id ?? null }),
      ),
    [],
  );
  const openPanel = useCallback(
    (id: string | undefined) =>
      navigate(
        withParams(location.pathname, location.search, { panel: id ?? null }),
        {
          replace: true,
        },
      ),
    [],
  );

  const pages = space.data?.pages ?? [];
  const current = pages.find((page) => page.id === props.pageId);
  const commands = useMemo<PaletteCommand[]>(() => {
    const out: PaletteCommand[] = [
      {
        id: "space.settings",
        label: "Space settings",
        run: () => navigate(`${base}/settings`),
      },
    ];
    if (canWrite) {
      out.unshift({
        id: "space.new-page",
        label: "New page",
        keywords: ["create", "add"],
        run: () =>
          fireWrite(
            write(undefined, async (target) => {
              const { page } = await api<{ page: { id: string } }>(
                "POST",
                withBranch(`${apiBase}/pages`, target),
                { title: "Untitled", parent: null },
              );
              openNew(page.id, target);
            }),
          ),
      });
    }
    return out;
  }, [base, apiBase, canWrite, write]);

  const error = space.error ?? plugins.error;
  if (error !== undefined) {
    return (
      <Frame orgId={orgId}>
        <div className="settings">
          <ErrorView error={error} />
          {error instanceof ApiError &&
            error.code === "api/branch-not-found" && (
              <p>
                <Link href={base}>Open the space at main</Link>
              </p>
            )}
        </div>
      </Frame>
    );
  }
  if (!space.data || !plugins.isReady) {
    return (
      <Frame orgId={orgId}>
        <p className="loading">Loading…</p>
      </Frame>
    );
  }
  const data = space.data;
  const spaceName = data.space.name;
  const isSettings = props.settings !== undefined;
  const first = pages
    .filter((page) => page.parent === null)
    .toSorted((a, b) => a.order - b.order)[0];
  if (
    !isSettings &&
    props.pageId === undefined &&
    first &&
    view === undefined
  ) {
    return <Redirect to={`${base}/pages/${first.id}${location.search}`} />;
  }

  const status = site.data;
  const ahead = isAhead(status);
  const shownView = views.find((item) => item.id === view);
  const shownPanel = isEditing
    ? panels.find((item) => item.id === panel)
    : undefined;
  const barProps: SpaceBarProps = {
    orgId,
    spaceId,
    branch,
    openBranch,
    entryId: props.pageId,
    isEditing,
    view,
    openView,
    panel: shownPanel?.id,
    openPanel,
    stopEditing,
    onStopEditing,
  };
  const trail = current ? ancestors(pages, current.id) : [];
  const isBranchShown = isEditing && branch !== MAIN_BRANCH;

  const nav = (
    <>
      <SideLabel
        action={
          <button
            type="button"
            className="icon-btn add"
            aria-label="Space actions"
            aria-haspopup="menu"
            onClick={(event) => spaceMenu.show(anchorOf(event), undefined)}
          >
            ⋯
          </button>
        }
      >
        <Link href={`/orgs/${orgId}`} title="All spaces" className="ell">
          {spaceName}
        </Link>
      </SideLabel>
      <PageTree
        spaceId={spaceId}
        base={base}
        apiBase={apiBase}
        branch={branch}
        pages={pages}
        mainPages={branch === MAIN_BRANCH ? undefined : main.data?.pages}
        currentId={isSettings ? undefined : props.pageId}
        canWrite={canWrite}
        isEditing={isEditing}
        write={write}
        openNew={openNew}
      />
      {sidebar.map((item) => {
        const Item = asComponent(item.component);
        return (
          <div className="side-slot" key={item.id}>
            <Item
              orgId={orgId}
              spaceId={spaceId}
              branch={branch}
              openBranch={openBranch}
            />
          </div>
        );
      })}
      {spaceMenu.open && (
        <Menu
          anchor={spaceMenu.open.anchor}
          label="Space actions"
          onClose={spaceMenu.close}
        >
          {canWrite && (
            <MenuItem
              icon="ig-plus"
              onSelect={() => {
                spaceMenu.close();
                commands
                  .find((command) => command.id === "space.new-page")
                  ?.run();
              }}
            >
              New page
            </MenuItem>
          )}
          <MenuItem
            icon="ig-link"
            onSelect={() => {
              spaceMenu.close();
              const url = new URL(base, location.origin).href;
              void navigator.clipboard?.writeText(url).then(
                () => ui.notify({ message: "Link copied" }),
                () => ui.notify({ message: url }),
              );
            }}
          >
            Copy link to space
          </MenuItem>
          <hr />
          <MenuItem
            icon="ig-edit"
            onSelect={() => {
              spaceMenu.close();
              navigate(`${base}/settings`);
            }}
          >
            Space settings
          </MenuItem>
        </Menu>
      )}
    </>
  );

  const foot = (
    <Link
      href={`${base}/settings`}
      className="side-link"
      aria-current={isSettings ? "page" : undefined}
    >
      <span className="g">
        <span className="ic ig-gear" />
      </span>
      Space settings
    </Link>
  );

  const header = (
    <header className="bar">
      <nav className="crumbs" aria-label="Breadcrumb">
        <Link className="cr-mid" href={`/orgs/${orgId}`}>
          {org.data?.org.name ?? "Organization"}
        </Link>
        <Link className="cr-mid" href={withBranch(base, branch)}>
          {spaceName}
        </Link>
        {!isSettings &&
          trail.map((page) => (
            <Link key={page.id} className="cr-mid" href={pageHref(page.id)}>
              {page.title || "Untitled"}
            </Link>
          ))}
        {(current || isSettings) && (
          <strong>
            {isSettings ? "Settings" : current?.title || "Untitled"}
          </strong>
        )}
      </nav>
      <span className="spacer" />
      {isSettings ? (
        <Link className="btn" href={withBranch(base, branch)}>
          Back to pages
        </Link>
      ) : isEditing ? (
        <>
          {branch === MAIN_BRANCH && (
            <span
              className="tag is-muted"
              title="A draft starts with your first change"
            >
              Editing
            </span>
          )}
          {isBranchShown && bar.length === 0 && (
            <span className="tag is-muted mono">{branch}</span>
          )}
          {bar.map((item) => {
            const Item = asComponent(item.component);
            return <Item key={item.id} {...barProps} />;
          })}
          {saveState && (
            <span
              className="save-state"
              role="status"
              style={{ order: 1 } as CSSProperties}
            >
              <span
                className={`ic ${saveState.kind === "saving" || saveState.kind === "dirty" ? "ic-run" : saveState.kind === "error" ? "ic-alert" : "ic-check"}`}
              />
              <span
                title={
                  saveState.kind === "error" ? saveState.message : undefined
                }
              >
                {SAVE_LABELS[saveState.kind]}
              </span>
            </span>
          )}
          <button
            type="button"
            className="btn bar-done"
            disabled={isLeaving}
            onClick={done}
          >
            Done
          </button>
        </>
      ) : (
        <>
          <SiteControls
            orgId={orgId}
            orgSlug={org.data?.org.slug ?? ""}
            spaceId={spaceId}
            spaceSlug={data.space.slug}
            spaceName={spaceName}
            status={status}
            hasPages={pages.length > 0}
            isPrimary={ahead && !draft.data}
            settingsHref={`${base}/settings#site`}
            onPublished={() => setSiteVersion((n) => n + 1)}
          />
          {bar.map((item) => {
            const Item = asComponent(item.component);
            return <Item key={item.id} {...barProps} />;
          })}
          {canWrite && (pages.length > 0 || draft.data) && (
            <button
              type="button"
              className={`btn bar-edit${draft.data || !ahead ? " is-primary" : ""}`}
              title={draft.data ? `Continue in ${draft.data.label}` : undefined}
              onClick={startEditing}
            >
              {draft.data ? "Continue editing" : "Edit"}
            </button>
          )}
        </>
      )}
    </header>
  );

  let content;
  if (isSettings) {
    content = (
      <SpaceSettings
        orgId={orgId}
        space={data.space}
        section={props.settings ?? ""}
        site={status}
        onSiteChange={() => setSiteVersion((n) => n + 1)}
        onSpaceChange={refresh}
        onPluginsChange={plugins.reload}
      />
    );
  } else if (shownView) {
    const View = asComponent(shownView.component);
    content = (
      <View
        orgId={orgId}
        spaceId={spaceId}
        branch={branch}
        openBranch={openBranch}
        entryId={props.pageId}
        close={() => openView(undefined)}
      />
    );
  } else if (pages.length === 0) {
    content = (
      <section className="empty">
        <h2>Start {spaceName}</h2>
        <p>
          Pages you add here stay private to the space until you publish them to
          a site.
        </p>
        <div className="acts">
          {canWrite && (
            <button
              type="button"
              className="btn is-primary"
              onClick={() =>
                commands
                  .find((command) => command.id === "space.new-page")
                  ?.run()
              }
            >
              New page
            </button>
          )}
          <Link className="btn" href={`${base}/settings`}>
            Space settings
          </Link>
        </div>
      </section>
    );
  } else if (current) {
    content = (
      <PageView
        orgId={orgId}
        spaceId={spaceId}
        pageId={current.id}
        title={current.title}
        canWrite={canWrite}
        isEditing={isEditing}
        branch={branch}
        openBranch={openBranch}
        gate={gate}
        isNew={params.get("new") === "1"}
        onSaveState={setSaveState}
        onRename={(title) =>
          fireWrite(
            write(current.id, (target) =>
              api(
                "PATCH",
                withBranch(`${apiBase}/pages/${current.id}`, target),
                {
                  title,
                },
              ),
            ),
          )
        }
      />
    );
  } else {
    content = (
      <div className="settings">
        <p role="alert">This page does not exist.</p>
      </div>
    );
  }

  const Panel = shownPanel && asComponent(shownPanel.component);
  return (
    <Frame
      orgId={orgId}
      nav={nav}
      foot={foot}
      palette={{ spaceId, entryId: props.pageId, branch, commands }}
      panel={
        Panel && (
          <Panel
            orgId={orgId}
            spaceId={spaceId}
            branch={branch}
            openBranch={openBranch}
            entryId={props.pageId}
            close={() => openPanel(undefined)}
          />
        )
      }
    >
      {header}
      {content}
    </Frame>
  );
}
