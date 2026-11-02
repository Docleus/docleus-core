import { useEffect, useState, type ReactNode } from "react";
import type { CommandContext, Org } from "@docleus/sdk";
import { api } from "../lib/api.ts";
import { useMe } from "../lib/auth.tsx";
import { MAIN_BRANCH } from "@docleus/sdk";
import { navigate, usePath } from "../lib/router.ts";
import { useLoad } from "../lib/use-load.ts";
import { rememberPlace } from "../lib/last-place.ts";
import { usePlugins } from "../lib/use-plugins.ts";
import { initials } from "../lib/format.ts";
import { Menu, MenuItem, Toasts, anchorOf, useLayer } from "./layers.tsx";
import { Palette, type PaletteCommand } from "./palette.tsx";

function leave(): void {
  navigate("/login");
}

/** The client leaves even when the server cannot be reached. */
export function signOut(): void {
  api("POST", "/api/auth/logout").then(leave, leave);
}

const PALETTE_KEY = "k";

/** The frontend endpoint for views at the level of `orgId`, or the instance. */
export function frontendOf(orgId: string | undefined): string {
  return orgId === undefined
    ? "/api/frontend"
    : `/api/orgs/${encodeURIComponent(orgId)}/frontend`;
}

/**
 * The signed-in frame: the sidebar (organization switcher, search, the
 * view's navigation, then settings and the account menu), the main column,
 * an optional side panel, toasts and the command palette. Below 820px the
 * sidebar is a drawer behind a menu button.
 */
export function Frame(props: {
  orgId?: string;
  /**
   * The frontend endpoint whose plugins this view shows (slots, settings
   * pages, palette sources). Views that load their own plugins leave it out.
   */
  frontend?: string;
  /** The view's navigation in the sidebar's scrolling part. */
  nav?: ReactNode;
  /** Links above the account row, such as the settings of the current level. */
  foot?: ReactNode;
  panel?: ReactNode;
  palette?: Partial<CommandContext> & {
    readonly commands?: readonly PaletteCommand[];
  };
  children: ReactNode;
}) {
  const [isDrawerOpen, setIsDrawerOpen] = useState(false);
  const [isPaletteOpen, setIsPaletteOpen] = useState(false);
  const path = usePath();
  usePlugins(props.frontend);
  useEffect(() => setIsDrawerOpen(false), [path]);
  useEffect(() => rememberPlace(path + location.search), [path]);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (
        (event.metaKey || event.ctrlKey) &&
        event.key.toLowerCase() === PALETTE_KEY
      ) {
        event.preventDefault();
        setIsPaletteOpen((open) => !open);
      } else if (event.key === "Escape") {
        setIsDrawerOpen(false);
      }
    };
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, []);
  const context: CommandContext = {
    orgId: props.orgId,
    spaceId: props.palette?.spaceId,
    entryId: props.palette?.entryId,
    branch: props.palette?.branch ?? MAIN_BRANCH,
  };

  return (
    <div
      className={`app${props.panel ? " has-panel" : ""}${isDrawerOpen ? " nav-open" : ""}`}
    >
      <aside className="side" aria-label="Sidebar">
        <OrgSwitcher orgId={props.orgId} />
        <button
          type="button"
          className="side-search"
          onClick={() => setIsPaletteOpen(true)}
        >
          Search<kbd>⌘K</kbd>
        </button>
        <div
          className="side-scroll"
          data-plate='.side-link[aria-current="page"], .trow[aria-current="page"]'
        >
          {props.nav}
        </div>
        <div className="side-foot">
          {props.foot}
          <AccountMenu orgId={props.orgId} />
        </div>
      </aside>
      <main className="main">{props.children}</main>
      {props.panel}
      <button
        type="button"
        className="nav-btn icon-btn"
        aria-label="Open navigation"
        onClick={() => setIsDrawerOpen(true)}
      >
        <span className="ic ig-menu" />
      </button>
      <div className="nav-scrim" onClick={() => setIsDrawerOpen(false)} />
      <Toasts />
      {isPaletteOpen && (
        <Palette
          context={context}
          commands={props.palette?.commands ?? []}
          onClose={() => setIsPaletteOpen(false)}
        />
      )}
    </div>
  );
}

function OrgSwitcher(props: { orgId: string | undefined }) {
  const me = useMe();
  const orgs = useLoad("frame/orgs", () =>
    api<{ orgs: Org[] }>("GET", "/api/orgs"),
  );
  const menu = useLayer();
  const current = orgs.data?.orgs.find((org) => org.id === props.orgId);
  const name = current?.name ?? "Docleus";
  return (
    <>
      <button
        type="button"
        className="switcher"
        aria-haspopup="menu"
        aria-expanded={menu.open !== undefined}
        onClick={(event) => menu.show(anchorOf(event), undefined)}
      >
        <span className="glyph">{name.slice(0, 1).toUpperCase()}</span>
        <span className="ell">{name}</span>
        <span className="caret ic ig-chevron" />
      </button>
      {menu.open && (
        <Menu
          anchor={menu.open.anchor}
          label="Organizations"
          width={232}
          onClose={menu.close}
        >
          <div className="mh">Organizations</div>
          {orgs.data?.orgs.map((org) => (
            <MenuItem
              key={org.id}
              role="menuitemradio"
              isActive={org.id === props.orgId}
              hint={org.id === props.orgId ? "✓" : undefined}
              onSelect={() => {
                menu.close();
                navigate(`/orgs/${org.id}`);
              }}
            >
              {org.name}
            </MenuItem>
          ))}
          <hr />
          <MenuItem
            icon="ig-folder"
            onSelect={() => {
              menu.close();
              navigate("/");
            }}
          >
            All organizations
          </MenuItem>
          {props.orgId !== undefined && (
            <MenuItem
              icon="ig-edit"
              onSelect={() => {
                menu.close();
                navigate(`/orgs/${props.orgId}/settings`);
              }}
            >
              Organization settings
            </MenuItem>
          )}
          {me?.isAdmin && (
            <MenuItem
              icon="ig-plus"
              onSelect={() => {
                menu.close();
                navigate("/?new=org");
              }}
            >
              New organization
            </MenuItem>
          )}
        </Menu>
      )}
    </>
  );
}

function AccountMenu(props: { orgId: string | undefined }) {
  const me = useMe();
  const menu = useLayer();
  const user = me?.user;
  if (!user) return null;
  const name = user.name || user.email;
  const go = (href: string) => {
    menu.close();
    navigate(href);
  };
  return (
    <>
      <button
        type="button"
        className="side-link account"
        aria-haspopup="menu"
        aria-label="Account"
        aria-expanded={menu.open !== undefined}
        onClick={(event) => menu.show(anchorOf(event), undefined)}
      >
        <span className="av">{initials(name)}</span>
        <span className="ell">{name}</span>
        <span className="caret ic ig-chevron" />
      </button>
      {menu.open && (
        <Menu anchor={menu.open.anchor} label="Account" onClose={menu.close}>
          <div className="mh">{user.email}</div>
          <MenuItem onSelect={() => go("/account")}>Account</MenuItem>
          {me.isAdmin && (
            <MenuItem
              onSelect={() =>
                go(
                  props.orgId === undefined
                    ? "/settings"
                    : `/orgs/${props.orgId}/settings/users`,
                )
              }
            >
              Instance settings
            </MenuItem>
          )}
          <hr />
          <MenuItem
            onSelect={() => {
              menu.close();
              signOut();
            }}
          >
            Sign out
          </MenuItem>
        </Menu>
      )}
    </>
  );
}

/** A sidebar section label, optionally a link, with an action on the right. */
export function SideLabel(props: { children: ReactNode; action?: ReactNode }) {
  return (
    <div className="side-label">
      {props.children}
      {props.action}
    </div>
  );
}
