import { useState, type ReactNode } from "react";
import type { Org, Site, Space } from "@docleus/sdk";
import { api } from "../lib/api.ts";
import { useMe } from "../lib/auth.tsx";
import { asComponent, useHost, useUiVersion } from "../lib/host.tsx";
import { navigate } from "../lib/router.ts";
import { useLoad } from "../lib/use-load.ts";
import { ErrorView } from "./error-view.tsx";
import { Frame, SideLabel, frontendOf } from "./frame.tsx";
import { InstancePlugins } from "./instance-plugins.tsx";
import { Dialog } from "./layers.tsx";
import { Link } from "./link.tsx";
import { OrgMembers } from "./members.tsx";
import { PluginSettings } from "./plugin-settings.tsx";
import { Row, SaveBar, Section } from "./settings-ui.tsx";
import { UsersSettings } from "./users.tsx";

function OrgGeneral(props: { org: Org; onChange(): void }) {
  const { ui } = useHost();
  const me = useMe();
  const [name, setName] = useState(props.org.name);
  const [slug, setSlug] = useState(props.org.slug);
  const [isBusy, setIsBusy] = useState(false);
  const [error, setError] = useState<unknown>();
  const [isDeleting, setIsDeleting] = useState(false);
  const [confirm, setConfirm] = useState("");
  const [deleteError, setDeleteError] = useState<unknown>();
  const isDirty = name !== props.org.name || slug !== props.org.slug;
  const save = async () => {
    setIsBusy(true);
    setError(undefined);
    try {
      await api("PATCH", `/api/orgs/${props.org.id}`, {
        name: name.trim(),
        slug: slug.trim(),
      });
      props.onChange();
      ui.notify({ message: "Saved organization settings" });
    } catch (cause) {
      setError(cause);
    } finally {
      setIsBusy(false);
    }
  };
  const remove = async () => {
    try {
      await api("DELETE", `/api/orgs/${props.org.id}`);
      ui.notify({ message: `Deleted ${props.org.name}` });
      navigate("/");
    } catch (cause) {
      setDeleteError(cause);
    }
  };
  return (
    <>
      <h1>General</h1>
      <form
        className="section"
        aria-label="Organization details"
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <header>
          <h2>Details</h2>
        </header>
        <Row label="Name" htmlFor="org-name">
          <input
            id="org-name"
            className="input"
            required
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
        </Row>
        <Row label="Slug" htmlFor="org-slug">
          <input
            id="org-slug"
            className="input mono"
            required
            value={slug}
            onChange={(event) => setSlug(event.target.value)}
          />
          <small className="muted field-note">
            Sites are served at /sites/<b>{slug || "…"}</b>/…
          </small>
        </Row>
        {isDirty && (
          <SaveBar
            isBusy={isBusy}
            error={error}
            onDiscard={() => {
              setName(props.org.name);
              setSlug(props.org.slug);
              setError(undefined);
            }}
          />
        )}
      </form>
      {me?.user && (
        <Section title="Danger zone" isDanger>
          <Row label="Delete organization">
            <button
              type="button"
              className="btn"
              onClick={() => {
                setConfirm("");
                setIsDeleting(true);
              }}
            >
              Delete {props.org.name}…
            </button>
          </Row>
        </Section>
      )}
      {isDeleting && (
        <Dialog
          role="alertdialog"
          title={`Delete ${props.org.name}?`}
          description="Every space, its sites and every revision are removed for good."
          onClose={() => setIsDeleting(false)}
          onSubmit={() => void remove()}
          footer={
            <>
              <button
                type="button"
                className="btn"
                onClick={() => setIsDeleting(false)}
              >
                Cancel
              </button>
              <button
                type="submit"
                className="btn is-danger"
                disabled={confirm !== props.org.slug}
              >
                Delete for good
              </button>
            </>
          }
        >
          <label className="field">
            <span>
              Type <span className="mono">{props.org.slug}</span> to confirm
            </span>
            <input
              className="input mono"
              value={confirm}
              onChange={(event) => setConfirm(event.target.value)}
            />
          </label>
          {deleteError !== undefined && <ErrorView error={deleteError} />}
        </Dialog>
      )}
    </>
  );
}

/** Every space with the site that starts from it; each links to its Site section. */
function SitesOverview(props: { org: Org }) {
  const orgId = props.org.id;
  const data = useLoad(`sites-overview/${orgId}`, async () => {
    const [{ spaces }, { sites }] = await Promise.all([
      api<{ spaces: Space[] }>("GET", `/api/orgs/${orgId}`),
      api<{ sites: (Site & { url: string })[] }>(
        "GET",
        `/api/orgs/${orgId}/sites`,
      ),
    ]);
    return { spaces, sites };
  });
  if (data.error !== undefined) return <ErrorView error={data.error} />;
  if (!data.data) return null;
  return (
    <Section title="Spaces">
      <table className="table tbl" aria-label="Sites of spaces">
        <thead>
          <tr>
            <th>Space</th>
            <th>Address</th>
            <th>Status</th>
            <th>
              <span className="visually-hidden">Actions</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {data.data.spaces.map((space) => {
            const site = data.data?.sites.find(
              (candidate) => candidate.spaces[0]?.spaceId === space.id,
            );
            return (
              <tr key={space.id}>
                <td>
                  <strong>{space.name}</strong>
                </td>
                <td className="mono">
                  {site ? (site.domain ?? site.url) : "—"}
                </td>
                <td>
                  <span
                    className={`tag${site?.active ? " is-solid" : " is-muted"}`}
                  >
                    {site?.active ? "Live" : "Not published"}
                  </span>
                </td>
                <td className="act">
                  <Link
                    className="btn is-quiet"
                    href={`/orgs/${orgId}/spaces/${space.id}/settings/site`}
                  >
                    Manage
                  </Link>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </Section>
  );
}

interface SettingsTab {
  readonly id: string;
  readonly label: string;
  readonly group: "org" | "instance";
  readonly render: () => ReactNode;
}

/**
 * Organization and instance settings in one layout: the sidebar becomes the
 * settings navigation (organization sections, then instance sections for
 * admins, then the settings pages plugins added at each level), the main
 * column shows one section. Without an org, only the instance sections.
 */
export function SettingsLayout(props: {
  orgId: string | undefined;
  section: string;
}) {
  const { ui } = useHost();
  useUiVersion();
  const me = useMe();
  const { orgId } = props;
  const org = useLoad(`settings/org/${orgId ?? ""}`, () =>
    orgId === undefined
      ? Promise.resolve(undefined)
      : api<{ org: Org }>("GET", `/api/orgs/${orgId}`).then(
          (result) => result.org,
        ),
  );
  const base = orgId === undefined ? "/settings" : `/orgs/${orgId}/settings`;
  const plugins = ui.settingsPages();
  const tabs: SettingsTab[] = [];
  if (orgId !== undefined) {
    tabs.push(
      {
        id: "general",
        label: "General",
        group: "org",
        render: () =>
          org.data && (
            <OrgGeneral
              key={org.data.slug + org.data.name}
              org={org.data}
              onChange={org.reload}
            />
          ),
      },
      {
        id: "members",
        label: "Members",
        group: "org",
        render: () => (
          <>
            <h1>Members</h1>
            <div className="section section-body org-members">
              <OrgMembers orgId={orgId} />
            </div>
          </>
        ),
      },
      {
        id: "sites",
        label: "Sites",
        group: "org",
        render: () => (
          <>
            <h1>Sites</h1>
            <p className="lead">
              Domains, history and rollback live in each space's settings.
            </p>
            {org.data && <SitesOverview org={org.data} />}
          </>
        ),
      },
      {
        id: "plugins",
        label: "Plugins",
        group: "org",
        render: () => (
          <>
            <h1>Plugins</h1>
            <p className="lead">
              Admins install new plugins under Instance › Installed plugins.
            </p>
            <Section title="Available in this instance">
              <PluginSettings scope={{ kind: "org", orgId }} />
            </Section>
          </>
        ),
      },
    );
    for (const page of plugins.filter((each) => each.scopes.includes("org"))) {
      const Page = asComponent(page.component);
      tabs.push({
        id: page.id,
        label: page.label,
        group: "org",
        render: () => (
          <>
            <h1>{page.label}</h1>
            <div className="section section-body">
              <Page scope={{ kind: "org", orgId }} />
            </div>
          </>
        ),
      });
    }
  }
  if (me?.isAdmin) {
    tabs.push(
      {
        id: "users",
        label: "Users",
        group: "instance",
        render: () => (
          <>
            <h1>Users</h1>
            <div className="section section-body">
              <UsersSettings />
            </div>
          </>
        ),
      },
      {
        id: "installed",
        label: "Installed plugins",
        group: "instance",
        render: () => (
          <>
            <h1>Installed plugins</h1>
            <p className="lead">
              Plugins run in-process with full access to this instance.
              Organizations turn them on one by one.
            </p>
            <InstancePlugins />
          </>
        ),
      },
    );
    for (const page of plugins.filter((each) =>
      each.scopes.includes("instance"),
    )) {
      const Page = asComponent(page.component);
      tabs.push({
        id: `instance-${page.id}`,
        label: page.label,
        group: "instance",
        render: () => (
          <>
            <h1>{page.label}</h1>
            <div className="section section-body">
              <Page scope={{ kind: "instance" }} />
            </div>
          </>
        ),
      });
    }
  }
  // `plugins` was the instance plugins tab before the settings layout.
  const section =
    orgId === undefined && props.section === "plugins"
      ? "installed"
      : props.section;
  const current = tabs.find((tab) => tab.id === section) ?? tabs[0];
  const link = (tab: SettingsTab) => (
    <Link
      key={tab.id}
      className="side-link"
      href={`${base}/${tab.id}`}
      aria-current={tab === current ? "page" : undefined}
    >
      {tab.label}
    </Link>
  );
  const nav = (
    <nav aria-label="Settings" className="snav">
      <Link
        className="side-link back"
        href={orgId === undefined ? "/" : `/orgs/${orgId}`}
      >
        ←{" "}
        {orgId === undefined
          ? "Organizations"
          : (org.data?.name ?? "Organization")}
      </Link>
      {tabs.some((tab) => tab.group === "org") && (
        <SideLabel>Organization</SideLabel>
      )}
      {tabs.filter((tab) => tab.group === "org").map(link)}
      {tabs.some((tab) => tab.group === "instance") && (
        <SideLabel>Instance</SideLabel>
      )}
      {tabs.filter((tab) => tab.group === "instance").map(link)}
    </nav>
  );
  return (
    <Frame
      {...(orgId !== undefined && { orgId })}
      frontend={frontendOf(orgId)}
      nav={nav}
    >
      <div className="settings" key={current?.id}>
        {org.error !== undefined && <ErrorView error={org.error} />}
        {current ? (
          current.render()
        ) : (
          <p className="muted">No settings here.</p>
        )}
      </div>
    </Frame>
  );
}
