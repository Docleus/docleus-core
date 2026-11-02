import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type DragEvent,
  type KeyboardEvent,
} from "react";
import { api } from "../lib/api.ts";
import { useHost } from "../lib/host.tsx";
import {
  buildTree,
  siblingsOf,
  subtreeIds,
  type PageSummary,
  type TreeNode,
} from "../lib/page-tree.ts";
import { navigate, withBranch } from "../lib/router.ts";
import { fireWrite } from "../lib/write.ts";
import {
  Dialog,
  Menu,
  MenuItem,
  anchorOf,
  useLayer,
  type Anchor,
} from "./layers.tsx";

/** Runs a write through the edit-branch gate; resolves with the branch written to. */
export type TreeWrite = <T>(
  entryId: string | undefined,
  action: (branch: string) => Promise<T>,
) => Promise<T>;

export interface PageTreeProps {
  readonly spaceId: string;
  /** `/orgs/:orgId/spaces/:spaceId`. */
  readonly base: string;
  readonly apiBase: string;
  readonly branch: string;
  readonly pages: readonly PageSummary[];
  /** The pages at `main`, to mark what the shown branch changed. */
  readonly mainPages: readonly PageSummary[] | undefined;
  readonly currentId: string | undefined;
  readonly canWrite: boolean;
  readonly isEditing: boolean;
  write: TreeWrite;
  /** Opens a page the tree just created, with its title ready to type. */
  openNew(pageId: string, branch: string): void;
}

type Drop = { readonly id: string; readonly at: "before" | "after" | "in" };

const expandedKey = (spaceId: string) => `docleus:tree:${spaceId}`;

function loadExpanded(spaceId: string): Set<string> {
  try {
    const raw = sessionStorage.getItem(expandedKey(spaceId));
    return new Set(raw ? (JSON.parse(raw) as string[]) : []);
  } catch {
    return new Set();
  }
}

function ancestorsOf(pages: readonly PageSummary[], id: string): string[] {
  const out: string[] = [];
  let current = pages.find((page) => page.id === id);
  while (current?.parent) {
    out.push(current.parent);
    current = pages.find((page) => page.id === current?.parent);
  }
  return out;
}

/** The order that puts a page between two siblings (either may be missing). */
function orderBetween(
  before: PageSummary | undefined,
  after: PageSummary | undefined,
): number {
  if (before && after) return (before.order + after.order) / 2;
  if (before) return before.order + 1;
  if (after) return after.order - 1;
  return 0;
}

function changeOf(
  page: PageSummary,
  mainPages: readonly PageSummary[] | undefined,
): "A" | "M" | undefined {
  if (!mainPages) return undefined;
  const main = mainPages.find((other) => other.id === page.id);
  if (!main) return "A";
  if (page.hash !== undefined && main.hash !== page.hash) return "M";
  return undefined;
}

interface Row {
  readonly node: TreeNode;
  readonly depth: number;
}

/** One Tab stop for the whole tree; arrows move between rows. */
function focusRow(from: HTMLElement, step: number | "first" | "last"): void {
  const links = [
    ...(from.closest("nav")?.querySelectorAll<HTMLElement>(".trow > a") ?? []),
  ];
  const index = links.indexOf(from);
  const next =
    step === "first"
      ? links[0]
      : step === "last"
        ? links.at(-1)
        : links[index + step];
  next?.focus();
}

/**
 * The page tree. Expansion sticks per space and opens to the current page.
 * Every row action is in the row's ⋯ menu (also on right-click); the + adds
 * a subpage. Rows drag to reorder and nest while editing. Writes go through
 * `write`, so the first one from the live view starts a draft.
 */
export function PageTree(props: PageTreeProps) {
  const { pages, currentId, spaceId } = props;
  const { ui } = useHost();
  const [expanded, setExpanded] = useState(() => loadExpanded(spaceId));
  const [renaming, setRenaming] = useState<string | undefined>();
  const [moving, setMoving] = useState<PageSummary | undefined>();
  const [dragging, setDragging] = useState<string | undefined>();
  const [drop, setDrop] = useState<Drop | undefined>();
  const menu = useLayer<PageSummary>();

  // Moving the current page or an ancestor changes its path without changing
  // its id. Expansion changes alone must not reopen a collapsed row.
  const openedFor = useRef<{ id: string; ancestors: string[] } | undefined>(
    undefined,
  );
  useEffect(() => {
    if (currentId === undefined) return;
    const up = ancestorsOf(pages, currentId);
    const previous = openedFor.current;
    if (
      previous?.id === currentId &&
      previous.ancestors.length === up.length &&
      previous.ancestors.every((id, index) => id === up[index])
    )
      return;
    if (up.length === 0 && pages.every((page) => page.id !== currentId)) return;
    openedFor.current = { id: currentId, ancestors: up };
    setExpanded((open) =>
      up.every((id) => open.has(id)) ? open : new Set([...open, ...up]),
    );
  }, [currentId, pages]);
  useEffect(() => {
    sessionStorage.setItem(expandedKey(spaceId), JSON.stringify([...expanded]));
  }, [spaceId, expanded]);

  const rows = useMemo(() => {
    const out: Row[] = [];
    const walk = (nodes: readonly TreeNode[], depth: number) => {
      for (const node of nodes) {
        out.push({ node, depth });
        if (expanded.has(node.page.id)) walk(node.children, depth + 1);
      }
    };
    walk(buildTree(pages), 0);
    return out;
  }, [pages, expanded]);

  const href = (id: string, branch = props.branch) =>
    withBranch(`${props.base}/pages/${id}`, branch);
  // Collapsing a page that holds the current one moves there, so the
  // current page never hides inside a closed row.
  const toggle = (id: string) => {
    const isClosing = expanded.has(id);
    setExpanded((open) => {
      const next = new Set(open);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
    if (
      isClosing &&
      currentId !== undefined &&
      ancestorsOf(pages, currentId).includes(id)
    ) {
      openedFor.current = { id, ancestors: ancestorsOf(pages, id) };
      navigate(href(id));
    }
  };
  const pageApi = (id: string, branch: string) =>
    withBranch(`${props.apiBase}/pages/${id}`, branch);

  const create = (parent: PageSummary | undefined) => {
    fireWrite(
      props.write(undefined, async (branch) => {
        const { page } = await api<{ page: { id: string } }>(
          "POST",
          withBranch(`${props.apiBase}/pages`, branch),
          { title: "Untitled", parent: parent?.id ?? null },
        );
        if (parent) setExpanded((open) => new Set([...open, parent.id]));
        props.openNew(page.id, branch);
      }),
    );
  };
  const patch = (page: PageSummary, body: object) =>
    props.write(page.id, (branch) =>
      api("PATCH", pageApi(page.id, branch), body),
    );
  const rename = (page: PageSummary, title: string | undefined) => {
    setRenaming(undefined);
    if (title !== undefined && title !== page.title)
      fireWrite(patch(page, { title }));
  };
  const duplicate = (page: PageSummary) => {
    const siblings = siblingsOf(pages, page);
    const next = siblings[siblings.findIndex((s) => s.id === page.id) + 1];
    fireWrite(
      props.write(undefined, async (branch) => {
        await api("POST", withBranch(`${props.apiBase}/pages`, branch), {
          title: `${page.title || "Untitled"} (copy)`,
          parent: page.parent,
          copyOf: page.id,
          order: orderBetween(page, next),
        });
        ui.notify({ message: `Duplicated “${page.title || "Untitled"}”` });
      }),
    );
  };
  const remove = (page: PageSummary) => {
    const gone = subtreeIds(pages, page.id);
    fireWrite(
      props.write(page.id, async (branch) => {
        const result = await api<{ removed: string[]; before: string | null }>(
          "DELETE",
          pageApi(page.id, branch),
        );
        if (currentId !== undefined && gone.has(currentId)) {
          navigate(withBranch(props.base, branch));
        }
        const before = result.before;
        ui.notify({
          message: `Deleted “${page.title || "Untitled"}”`,
          ...(before !== null && {
            action: {
              label: "Undo",
              run: () =>
                fireWrite(
                  props.write(undefined, (target) =>
                    api(
                      "POST",
                      withBranch(`${props.apiBase}/pages/restore`, target),
                      { from: before, ids: result.removed },
                    ),
                  ),
                ),
            },
          }),
        });
      }),
    );
  };
  const copyLink = (page: PageSummary) => {
    const url = new URL(`${props.base}/pages/${page.id}`, location.origin);
    void navigator.clipboard?.writeText(url.href).then(
      () => ui.notify({ message: "Link copied" }),
      () => ui.notify({ message: url.href }),
    );
  };

  const onDragOver = (event: DragEvent, page: PageSummary) => {
    if (dragging === undefined || dragging === page.id) return;
    if (subtreeIds(pages, dragging).has(page.id)) return;
    event.preventDefault();
    const box = (event.currentTarget as HTMLElement).getBoundingClientRect();
    const y = (event.clientY - box.top) / box.height;
    const at = y < 0.28 ? "before" : y > 0.72 ? "after" : "in";
    if (drop?.id !== page.id || drop.at !== at) setDrop({ id: page.id, at });
  };
  const onDrop = () => {
    const moved = pages.find((page) => page.id === dragging);
    const target = pages.find((page) => page.id === drop?.id);
    setDragging(undefined);
    setDrop(undefined);
    if (!moved || !target || !drop) return;
    if (drop.at === "in") {
      const last = siblingsOf(
        pages.filter((page) => page.id !== moved.id),
        { ...target, parent: target.id },
      ).at(-1);
      setExpanded((open) => new Set([...open, target.id]));
      fireWrite(
        patch(moved, {
          parent: target.id,
          order: orderBetween(last, undefined),
        }),
      );
      return;
    }
    const siblings = siblingsOf(
      pages.filter((page) => page.id !== moved.id),
      target,
    );
    const index = siblings.findIndex((page) => page.id === target.id);
    const order =
      drop.at === "before"
        ? orderBetween(siblings[index - 1], target)
        : orderBetween(target, siblings[index + 1]);
    fireWrite(patch(moved, { parent: target.parent, order }));
  };

  const openMenu = (anchor: Anchor, page: PageSummary) =>
    menu.show(anchor, page);
  const onRowKey = (event: KeyboardEvent, row: Row) => {
    const { page } = row.node;
    const target = event.currentTarget as HTMLElement;
    if (event.key === "ArrowDown") {
      focusRow(target, 1);
    } else if (event.key === "ArrowUp") {
      focusRow(target, -1);
    } else if (event.key === "Home") {
      focusRow(target, "first");
    } else if (event.key === "End") {
      focusRow(target, "last");
    } else if (event.key === "ArrowRight" && row.node.children.length > 0) {
      if (!expanded.has(page.id)) toggle(page.id);
      else focusRow(target, 1);
    } else if (event.key === "ArrowLeft" && expanded.has(page.id)) {
      toggle(page.id);
    } else if (event.key === "F2" && props.canWrite) {
      setRenaming(page.id);
    } else if (
      event.key === "ContextMenu" ||
      (event.shiftKey && event.key === "F10")
    ) {
      openMenu(
        { kind: "element", element: event.currentTarget as HTMLElement },
        page,
      );
    } else {
      return;
    }
    event.preventDefault();
  };

  const tabStop =
    rows.find((row) => row.node.page.id === currentId)?.node.page.id ??
    rows[0]?.node.page.id;

  return (
    <nav aria-label="Pages" className="tree-nav">
      {rows.map((row) => {
        const { page } = row.node;
        const isCurrent = page.id === currentId;
        const change = changeOf(page, props.mainPages);
        const title = page.title || "Untitled";
        if (renaming === page.id) {
          return (
            <RenameRow
              key={page.id}
              depth={row.depth}
              title={page.title}
              onDone={(value) => rename(page, value)}
            />
          );
        }
        const classes = [
          "trow",
          isCurrent && "is-current",
          menu.open?.value.id === page.id && "is-menu",
          dragging === page.id && "is-dragging",
          drop?.id === page.id && `drop-${drop.at}`,
          drop?.id === page.id && drop.at === "in" && "is-drop",
        ]
          .filter(Boolean)
          .join(" ");
        return (
          <div
            key={page.id}
            className={classes}
            style={{ "--d": row.depth } as CSSProperties}
            aria-current={isCurrent ? "page" : undefined}
            draggable={props.isEditing && props.canWrite}
            onDragStart={(event) => {
              event.dataTransfer.effectAllowed = "move";
              event.dataTransfer.setData("text/plain", title);
              setDragging(page.id);
            }}
            onDragOver={(event) => onDragOver(event, page)}
            onDragLeave={() => setDrop(undefined)}
            onDrop={(event) => {
              event.preventDefault();
              onDrop();
            }}
            onDragEnd={() => {
              setDragging(undefined);
              setDrop(undefined);
            }}
            onClick={() => navigate(href(page.id))}
            onContextMenu={(event) => {
              event.preventDefault();
              openMenu(anchorOf(event), page);
            }}
          >
            <button
              type="button"
              className={`chev${row.node.children.length === 0 ? " is-leaf" : ""}`}
              aria-expanded={expanded.has(page.id)}
              aria-label={`Toggle ${title}`}
              tabIndex={-1}
              onClick={(event) => {
                event.stopPropagation();
                toggle(page.id);
              }}
            >
              ▶
            </button>
            <a
              href={href(page.id)}
              aria-current={isCurrent ? "page" : undefined}
              tabIndex={page.id === tabStop ? 0 : -1}
              onClick={(event) => event.preventDefault()}
              onKeyDown={(event) => {
                if (event.key === "Enter") navigate(href(page.id));
                else onRowKey(event, row);
              }}
            >
              {title}
            </a>
            {change && (
              <span
                className="chg"
                title={
                  change === "A"
                    ? "Added in this draft"
                    : "Edited in this draft"
                }
              >
                <span className={`chl is-${change.toLowerCase()}`}>
                  {change}
                </span>
              </span>
            )}
            {props.canWrite && (
              <span className="tacts">
                <button
                  type="button"
                  className="icon-btn"
                  tabIndex={-1}
                  title="New subpage"
                  aria-label={`New subpage in ${title}`}
                  onClick={(event) => {
                    event.stopPropagation();
                    create(page);
                  }}
                >
                  <span className="ic ig-plus" />
                </button>
                <button
                  type="button"
                  className="icon-btn"
                  tabIndex={-1}
                  title="More actions"
                  aria-haspopup="menu"
                  aria-label={`Actions for ${title}`}
                  onClick={(event) => {
                    event.stopPropagation();
                    openMenu(anchorOf(event), page);
                  }}
                >
                  ⋯
                </button>
              </span>
            )}
          </div>
        );
      })}
      {props.canWrite && (
        <button
          type="button"
          className="tree-new"
          onClick={() => create(undefined)}
        >
          + New page
        </button>
      )}
      {menu.open && (
        <Menu
          anchor={menu.open.anchor}
          label={`Actions for ${menu.open.value.title || "Untitled"}`}
          onClose={menu.close}
        >
          <PageMenuItems
            page={menu.open.value}
            canWrite={props.canWrite}
            isEditing={props.isEditing}
            onAction={(action) => {
              const page = menu.open?.value;
              menu.close();
              if (!page) return;
              if (action === "sub") create(page);
              else if (action === "rename") setRenaming(page.id);
              else if (action === "duplicate") duplicate(page);
              else if (action === "link") copyLink(page);
              else if (action === "move") setMoving(page);
              else remove(page);
            }}
          />
        </Menu>
      )}
      {moving && (
        <MoveDialog
          page={moving}
          pages={pages}
          onClose={() => setMoving(undefined)}
          onMove={(parent) => {
            const page = moving;
            setMoving(undefined);
            if (parent !== page.parent) fireWrite(patch(page, { parent }));
          }}
        />
      )}
    </nav>
  );
}

type PageAction = "sub" | "rename" | "duplicate" | "link" | "move" | "delete";

function PageMenuItems(props: {
  page: PageSummary;
  canWrite: boolean;
  isEditing: boolean;
  onAction(action: PageAction): void;
}) {
  return (
    <>
      <div className="mh">{props.page.title || "Untitled"}</div>
      {props.canWrite && (
        <>
          <MenuItem icon="ig-plus" onSelect={() => props.onAction("sub")}>
            New subpage
          </MenuItem>
          <MenuItem icon="ig-edit" onSelect={() => props.onAction("rename")}>
            Rename
          </MenuItem>
          <MenuItem icon="ig-copy" onSelect={() => props.onAction("duplicate")}>
            Duplicate
          </MenuItem>
        </>
      )}
      <MenuItem icon="ig-link" onSelect={() => props.onAction("link")}>
        Copy link
      </MenuItem>
      {props.canWrite && (
        <>
          <MenuItem icon="ig-move" onSelect={() => props.onAction("move")}>
            Move to…
          </MenuItem>
          <hr />
          <MenuItem
            icon="ig-trash"
            isDanger
            onSelect={() => props.onAction("delete")}
          >
            Delete
          </MenuItem>
          {!props.isEditing && (
            <p className="muted menu-note">Changes start a draft.</p>
          )}
        </>
      )}
    </>
  );
}

function RenameRow(props: {
  depth: number;
  title: string;
  onDone(title: string | undefined): void;
}) {
  const [title, setTitle] = useState(props.title);
  return (
    <div
      className="trow is-renaming"
      style={{ "--d": props.depth } as CSSProperties}
    >
      <span className="chev is-leaf" />
      <input
        aria-label="Rename page"
        autoFocus
        value={title}
        onFocus={(event) => event.currentTarget.select()}
        onChange={(event) => setTitle(event.target.value)}
        onBlur={() => props.onDone(title.trim())}
        onKeyDown={(event) => {
          if (event.key === "Enter") props.onDone(title.trim());
          else if (event.key === "Escape") props.onDone(undefined);
        }}
      />
    </div>
  );
}

function MoveDialog(props: {
  page: PageSummary;
  pages: readonly PageSummary[];
  onClose(): void;
  onMove(parent: string | null): void;
}) {
  const [query, setQuery] = useState("");
  const blocked = subtreeIds(props.pages, props.page.id);
  const rows: { page: PageSummary; depth: number }[] = [];
  const walk = (nodes: readonly TreeNode[], depth: number) => {
    for (const node of nodes) {
      if (blocked.has(node.page.id)) continue;
      rows.push({ page: node.page, depth });
      walk(node.children, depth + 1);
    }
  };
  walk(buildTree(props.pages), 0);
  const q = query.trim().toLowerCase();
  const shown = rows.filter(
    (row) =>
      q === "" || (row.page.title || "Untitled").toLowerCase().includes(q),
  );
  return (
    <Dialog
      title={`Move “${props.page.title || "Untitled"}”`}
      description="Pick the page it should sit under."
      onClose={props.onClose}
      footer={
        <button type="button" className="btn" onClick={props.onClose}>
          Cancel
        </button>
      }
    >
      <input
        className="input"
        placeholder="Find a page"
        aria-label="Find a page"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
      />
      <div className="menu move-list" role="listbox" aria-label="Pages">
        {q === "" && (
          <button
            type="button"
            className="mi"
            role="option"
            aria-selected={props.page.parent === null}
            onClick={() => props.onMove(null)}
          >
            <span className="g">
              <span className="ic ig-folder" />
            </span>
            Top level
            {props.page.parent === null && <span className="k">current</span>}
          </button>
        )}
        {shown.map((row) => (
          <button
            key={row.page.id}
            type="button"
            className={`mi${props.page.parent === row.page.id ? " is-active" : ""}`}
            role="option"
            aria-selected={props.page.parent === row.page.id}
            onClick={() => props.onMove(row.page.id)}
          >
            <span
              className="ell"
              style={{ paddingLeft: q === "" ? row.depth * 16 : 0 }}
            >
              {row.page.title || "Untitled"}
            </span>
            {props.page.parent === row.page.id && (
              <span className="k">current</span>
            )}
          </button>
        ))}
      </div>
    </Dialog>
  );
}
