import { useEffect, useState, type CSSProperties, type ReactNode } from "react";
import type { Org, Space } from "@docleus/sdk";
import { api } from "../lib/api.ts";
import { useMe } from "../lib/auth.tsx";
import { plural, slugify } from "../lib/format.ts";
import { asComponent, useSlot } from "../lib/host.tsx";
import { navigate, usePath, useSearchParams } from "../lib/router.ts";
import { useLoad } from "../lib/use-load.ts";
import { ErrorView } from "./error-view.tsx";
import { Frame, SideLabel, frontendOf } from "./frame.tsx";
import { Time } from "./time.tsx";
import { landingPath } from "../lib/last-place.ts";
import { Dialog } from "./layers.tsx";
import { Link } from "./link.tsx";

interface PluginInfo {
  readonly name: string;
  readonly enabled: boolean;
}

/** A space as the org endpoint lists it, with a summary for its card. */
type SpaceCard = Space & {
  readonly pageCount?: number;
  readonly editedAt?: number | null;
};

/** Name and slug fields; the slug follows the name until edited. */
function NameAndSlug(props: {
  name: string;
  slug: string;
  onChange(value: { name: string; slug: string }): void;
  namePlaceholder?: string;
}) {
  const [isSlugEdited, setIsSlugEdited] = useState(false);
  return (
    <>
      <label className="field">
        <span>Name</span>
        <input
          className="input"
          required
          autoFocus
          placeholder={props.namePlaceholder}
          value={props.name}
          onChange={(event) =>
            props.onChange({
              name: event.target.value,
              slug: isSlugEdited ? props.slug : slugify(event.target.value),
            })
          }
        />
      </label>
      <label className="field">
        <span>Slug</span>
        <input
          className="input mono"
          required
          value={props.slug}
          onChange={(event) => {
            setIsSlugEdited(true);
            props.onChange({ name: props.name, slug: event.target.value });
          }}
        />
      </label>
    </>
  );
}

function CreateDialog(props: {
  title: string;
  description: string;
  label: string;
  namePlaceholder?: string;
  onClose(): void;
  onCreate(input: { slug: string; name: string }): Promise<void>;
}) {
  const [value, setValue] = useState({ name: "", slug: "" });
  const [error, setError] = useState<unknown>();
  const [isBusy, setIsBusy] = useState(false);
  const submit = async () => {
    setIsBusy(true);
    try {
      await props.onCreate({
        name: value.name.trim(),
        slug: value.slug.trim(),
      });
    } catch (cause) {
      setError(cause);
      setIsBusy(false);
    }
  };
  return (
    <Dialog
      title={props.title}
      description={props.description}
      onClose={props.onClose}
      onSubmit={() => void submit()}
      formLabel={props.label}
      footer={
        <>
          <button type="button" className="btn" onClick={props.onClose}>
            Cancel
          </button>
          <button
            type="submit"
            className="btn is-primary"
            disabled={isBusy || value.name.trim() === "" || value.slug === ""}
          >
            {props.label}
          </button>
        </>
      }
    >
      <NameAndSlug
        {...value}
        {...(props.namePlaceholder !== undefined && {
          namePlaceholder: props.namePlaceholder,
        })}
        onChange={setValue}
      />
      {error !== undefined && <ErrorView error={error} />}
    </Dialog>
  );
}

async function createOrg(input: { slug: string; name: string }): Promise<void> {
  const { org } = await api<{ org: Org }>("POST", "/api/orgs", input);
  // A new organization starts with every installed plugin enabled; its
  // settings page turns them off.
  const { plugins } = await api<{ plugins: PluginInfo[] }>(
    "GET",
    `/api/orgs/${org.id}/plugins`,
  );
  for (const plugin of plugins) {
    await api("PUT", `/api/orgs/${org.id}/plugins`, {
      plugin: plugin.name,
      enabled: true,
    });
  }
  navigate(`/orgs/${org.id}`);
}

/** All organizations the user can see; admins create new ones here. */
export function OrgList() {
  const me = useMe();
  const params = useSearchParams();
  const path = usePath();
  const orgs = useLoad("orgs", () => api<{ orgs: Org[] }>("GET", "/api/orgs"));
  const isCreating = params.get("new") === "org";
  const close = () => navigate(path, { replace: true });
  const isAdmin = me?.isAdmin === true;
  const list = orgs.data?.orgs ?? [];
  const landing =
    params.get("landing") === "1" && orgs.data
      ? landingPath(list.map((org) => org.id))
      : undefined;
  useEffect(() => {
    if (params.get("landing") !== "1" || !orgs.data) return;
    navigate(landing ?? "/", { replace: true });
  }, [params, orgs.data, landing]);

  return (
    <Frame
      frontend={frontendOf(undefined)}
      nav={
        <>
          <Link className="side-link" href="/" aria-current="page">
            Organizations
          </Link>
          {list.map((org) => (
            <Link key={org.id} className="side-link" href={`/orgs/${org.id}`}>
              <span className="ell">{org.name}</span>
            </Link>
          ))}
        </>
      }
    >
      <section className="home">
        <h1>Organizations</h1>
        {orgs.error !== undefined && <ErrorView error={orgs.error} />}
        {orgs.data && list.length === 0 && !isAdmin && (
          <p className="work-empty">
            You are not in an organization yet. Ask an admin for an invitation.
          </p>
        )}
        {list.length > 0 && (
          <div className="spaces">
            {list.map((org, i) => (
              <Link
                key={org.id}
                className="card stagger"
                style={{ "--i": i } as CSSProperties}
                href={`/orgs/${org.id}`}
              >
                <strong>{org.name}</strong>
                <p className="mono">{org.slug}</p>
              </Link>
            ))}
          </div>
        )}
        {isAdmin &&
          (orgs.data && list.length === 0 && !isCreating ? (
            <InlineCreateOrg />
          ) : (
            <p className="home-action">
              <button
                type="button"
                className="btn"
                onClick={() => navigate("/?new=org")}
              >
                New organization
              </button>
            </p>
          ))}
      </section>
      {isCreating && isAdmin && (
        <CreateDialog
          title="New organization"
          description="Spaces, members and sites belong to an organization."
          label="Create organization"
          onClose={close}
          onCreate={createOrg}
        />
      )}
    </Frame>
  );
}

/** The first organization of an instance, created in place. */
function InlineCreateOrg() {
  const [value, setValue] = useState({ name: "", slug: "" });
  const [error, setError] = useState<unknown>();
  return (
    <form
      className="section first-org"
      aria-label="Create organization"
      onSubmit={(event) => {
        event.preventDefault();
        createOrg({ name: value.name.trim(), slug: value.slug.trim() }).catch(
          setError,
        );
      }}
    >
      <header>
        <h2>Create the first organization</h2>
      </header>
      <div className="db">
        <NameAndSlug
          {...value}
          onChange={setValue}
          namePlaceholder="Northwind"
        />
        {error !== undefined && <ErrorView error={error} />}
      </div>
      <footer>
        <button type="submit" className="btn is-primary">
          Create organization
        </button>
      </footer>
    </form>
  );
}

function greeting(name: string | undefined): string {
  const hour = new Date().getHours();
  const part =
    hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening";
  const first = name?.split(/\s+/)[0];
  return first ? `${part}, ${first}` : part;
}

/** The sidebar of an organization: home, then its spaces. */
export function OrgNav(props: {
  orgId: string;
  spaces: readonly Space[];
  isHome: boolean;
  onNewSpace?(): void;
}) {
  return (
    <>
      <Link
        className="side-link"
        href={`/orgs/${props.orgId}`}
        aria-current={props.isHome ? "page" : undefined}
      >
        Home
      </Link>
      <SideLabel
        action={
          props.onNewSpace && (
            <button
              type="button"
              className="icon-btn add"
              aria-label="New space"
              onClick={props.onNewSpace}
            >
              +
            </button>
          )
        }
      >
        Spaces
      </SideLabel>
      {props.spaces.map((space) => (
        <Link
          key={space.id}
          className="side-link"
          href={`/orgs/${props.orgId}/spaces/${space.id}`}
        >
          <span className="ell">{space.name}</span>
        </Link>
      ))}
    </>
  );
}

/** An organization's home: what is waiting for the user, then its spaces. */
export function OrgHome(props: { orgId: string }) {
  const { orgId } = props;
  const me = useMe();
  const params = useSearchParams();
  const path = usePath();
  const org = useLoad(`org/${orgId}`, () =>
    api<{ org: Org; spaces: SpaceCard[] }>("GET", `/api/orgs/${orgId}`),
  );
  const sites = useLoad(`org/${orgId}/sites`, () =>
    api<{ sites: { spaces: { spaceId: string }[]; active?: string }[] }>(
      "GET",
      `/api/orgs/${orgId}/sites`,
    ).catch(() => ({ sites: [] })),
  );
  const home = useSlot("org.home");
  const isCreating = params.get("new") === "space";
  const openCreate = () => navigate(`${path}?new=space`);
  const closeCreate = () => navigate(path, { replace: true });

  if (org.error !== undefined) {
    return (
      <Frame orgId={orgId} frontend={frontendOf(orgId)}>
        <div className="settings">
          <ErrorView error={org.error} />
        </div>
      </Frame>
    );
  }
  const spaces = org.data?.spaces ?? [];
  const create = async (input: { slug: string; name: string }) => {
    const { space } = await api<{ space: Space }>(
      "POST",
      `/api/orgs/${orgId}/spaces`,
      input,
    );
    navigate(`/orgs/${orgId}/spaces/${space.id}`);
  };
  const liveSpaces = new Set(
    (sites.data?.sites ?? [])
      .filter((site) => site.active)
      .map((site) => site.spaces[0]?.spaceId),
  );
  let body: ReactNode = null;
  if (org.data && spaces.length === 0) {
    body = (
      <section className="empty">
        <h2>Create the first space</h2>
        <p>
          A space holds one set of pages, such as a handbook or an API
          reference, with its own site. {org.data.org.name} has none yet.
        </p>
        <div className="acts">
          <button type="button" className="btn is-primary" onClick={openCreate}>
            New space
          </button>
          <Link className="btn" href={`/orgs/${orgId}/settings/members`}>
            Invite members
          </Link>
        </div>
      </section>
    );
  } else if (org.data) {
    body = (
      <section className="home">
        <h1>{greeting(me?.user?.name)}</h1>
        {home.map((item) => {
          const Item = asComponent(item.component);
          return <Item key={item.id} orgId={orgId} />;
        })}
        <h2>
          Spaces
          <button type="button" className="btn" onClick={openCreate}>
            New space
          </button>
        </h2>
        <div className="spaces">
          {spaces.map((space, i) => {
            const isLive = liveSpaces.has(space.id);
            return (
              <Link
                key={space.id}
                className="card stagger"
                style={{ "--i": i } as CSSProperties}
                href={`/orgs/${orgId}/spaces/${space.id}`}
              >
                <strong>{space.name}</strong>
                <p>{space.description || "No description"}</p>
                <span className="foot">
                  <span className={`tag ${isLive ? "is-solid" : "is-muted"}`}>
                    {isLive ? "Live" : "Not published"}
                  </span>
                  {space.pageCount !== undefined && (
                    <span>{plural(space.pageCount, "page")}</span>
                  )}
                  {space.editedAt ? (
                    <span>
                      edited <Time at={space.editedAt} />
                    </span>
                  ) : null}
                </span>
              </Link>
            );
          })}
        </div>
      </section>
    );
  }
  return (
    <Frame
      orgId={orgId}
      frontend={frontendOf(orgId)}
      nav={
        <OrgNav orgId={orgId} spaces={spaces} isHome onNewSpace={openCreate} />
      }
      foot={
        <Link className="side-link" href={`/orgs/${orgId}/settings`}>
          <span className="g">
            <span className="ic ig-gear" />
          </span>
          Organization settings
        </Link>
      }
    >
      {body}
      {isCreating && (
        <CreateDialog
          title="New space"
          description="One set of pages with its own drafts and site."
          label="Create space"
          namePlaceholder="Security handbook"
          onClose={closeCreate}
          onCreate={create}
        />
      )}
    </Frame>
  );
}
