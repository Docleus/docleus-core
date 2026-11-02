import { useEffect, useState } from "react";
import { fullTime, relativeTime, type Space } from "@docleus/sdk";
import { api } from "../lib/api.ts";
import { short } from "../lib/format.ts";
import { asComponent, useHost, useUiVersion } from "../lib/host.tsx";
import { navigate } from "../lib/router.ts";
import { ErrorView } from "./error-view.tsx";
import { Dialog } from "./layers.tsx";
import { SpaceMembers } from "./members.tsx";
import { createAndPublish, type SiteStatus } from "./publish.tsx";
import { PluginSettings } from "./plugin-settings.tsx";
import { Row, SaveBar, Section, useScrollToSection } from "./settings-ui.tsx";

function GeneralForm(props: { orgId: string; space: Space; onChange(): void }) {
  const { ui } = useHost();
  const [name, setName] = useState(props.space.name);
  const [description, setDescription] = useState(props.space.description ?? "");
  const [isBusy, setIsBusy] = useState(false);
  const [error, setError] = useState<unknown>();
  const isDirty =
    name !== props.space.name ||
    description !== (props.space.description ?? "");
  const discard = () => {
    setName(props.space.name);
    setDescription(props.space.description ?? "");
    setError(undefined);
  };
  const save = async () => {
    setIsBusy(true);
    setError(undefined);
    try {
      await api("PATCH", `/api/orgs/${props.orgId}/spaces/${props.space.id}`, {
        name: name.trim(),
        description: description.trim(),
      });
      props.onChange();
      ui.notify({ message: "Saved space settings" });
    } catch (cause) {
      setError(cause);
    } finally {
      setIsBusy(false);
    }
  };
  return (
    <form
      id="general"
      className="section"
      aria-label="General"
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      <header>
        <h2>General</h2>
      </header>
      <Row label="Name" htmlFor="space-name">
        <input
          id="space-name"
          className="input"
          required
          value={name}
          onChange={(event) => setName(event.target.value)}
        />
      </Row>
      <Row label="Description" htmlFor="space-description">
        <textarea
          id="space-description"
          className="input"
          rows={2}
          maxLength={280}
          placeholder="What this space is for"
          value={description}
          onChange={(event) => setDescription(event.target.value)}
        />
      </Row>
      {isDirty && <SaveBar isBusy={isBusy} onDiscard={discard} error={error} />}
    </form>
  );
}

function SiteSection(props: {
  orgId: string;
  space: Space;
  status: SiteStatus | undefined;
  onChange(): void;
}) {
  const { ui } = useHost();
  const { status } = props;
  const site = status?.site ?? null;
  const [domain, setDomain] = useState(site?.domain ?? "");
  const [isUnpublishing, setIsUnpublishing] = useState(false);
  const [error, setError] = useState<unknown>();
  useEffect(() => setDomain(site?.domain ?? ""), [site?.domain]);
  if (!status) return null;
  const run = async (action: () => Promise<unknown>, message: string) => {
    setError(undefined);
    try {
      await action();
      props.onChange();
      ui.notify({ message });
    } catch (cause) {
      setError(cause);
    }
  };
  const siteApi = site ? `/api/orgs/${props.orgId}/sites/${site.id}` : "";

  return (
    <Section
      id="site"
      title="Site"
      aside={
        <span
          className={`tag section-tag${site?.active ? " is-solid" : " is-muted"}`}
        >
          {site?.active ? "Live" : "Not published"}
        </span>
      }
    >
      {site ? (
        <>
          <Row label="Address">
            <a
              className="mono"
              href={site.url}
              target="_blank"
              rel="noreferrer"
            >
              {site.url}
            </a>
          </Row>
          <Row label="Custom domain" htmlFor="site-domain">
            <span className="inline-control">
              <input
                id="site-domain"
                className="input"
                placeholder="docs.example.com"
                value={domain}
                disabled={!status.canPublish}
                onChange={(event) => setDomain(event.target.value)}
              />
              {domain !== (site.domain ?? "") && (
                <button
                  type="button"
                  className="btn"
                  onClick={() =>
                    void run(
                      () =>
                        api("PATCH", siteApi, {
                          domain: domain.trim() || null,
                        }),
                      domain.trim()
                        ? `Domain set to ${domain.trim()}`
                        : "Domain removed",
                    )
                  }
                >
                  Save
                </button>
              )}
              {site.domain && domain === site.domain && (
                <span className="res">
                  <span className="ic ic-check" />
                  Saved
                </span>
              )}
            </span>
          </Row>
          <Row label="History">
            {(status.history ?? []).length === 0 ? (
              <span className="muted">Nothing published yet.</span>
            ) : (
              <ul className="plist history">
                {(status.history ?? []).map((entry) => (
                  <li key={entry.publication}>
                    <time title={fullTime(entry.at)}>
                      {relativeTime(entry.at)}
                    </time>
                    <span className="muted">
                      {entry.byName ?? ""}
                      {entry.revision && (
                        <span className="mono"> {short(entry.revision)}</span>
                      )}
                    </span>
                    <span className="r">
                      {entry.publication === site.active ? (
                        <span className="tag is-solid">Live</span>
                      ) : (
                        status.canPublish && (
                          <button
                            type="button"
                            className="btn is-quiet"
                            onClick={() =>
                              void run(
                                () =>
                                  api("POST", `${siteApi}/activate`, {
                                    publication: entry.publication,
                                  }),
                                `Restored the version published ${relativeTime(entry.at)}`,
                              )
                            }
                          >
                            Roll back
                          </button>
                        )
                      )}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </Row>
          {status.canPublish && (
            <Row label="Unpublish">
              <button
                type="button"
                className="btn"
                onClick={() => setIsUnpublishing(true)}
              >
                Unpublish site
              </button>
            </Row>
          )}
        </>
      ) : (
        <Row label="Not published">
          <button
            type="button"
            className="btn is-primary"
            disabled={!status.canPublish}
            onClick={() =>
              void run(
                () =>
                  createAndPublish({
                    orgId: props.orgId,
                    spaceId: props.space.id,
                    slug: props.space.slug,
                    name: props.space.name,
                  }),
                `Published ${props.space.name}`,
              )
            }
          >
            Publish
          </button>
        </Row>
      )}
      {error !== undefined && (
        <div className="row">
          <ErrorView error={error} />
        </div>
      )}
      {isUnpublishing && site && (
        <Dialog
          role="alertdialog"
          title={`Unpublish ${props.space.name}?`}
          description="Readers get a 404, and the publish history is deleted. Publishing again starts a new site."
          onClose={() => setIsUnpublishing(false)}
          footer={
            <>
              <button
                type="button"
                className="btn"
                onClick={() => setIsUnpublishing(false)}
              >
                Cancel
              </button>
              <button
                type="button"
                className="btn is-danger"
                onClick={() => {
                  setIsUnpublishing(false);
                  void run(
                    () => api("DELETE", siteApi),
                    `Unpublished ${props.space.name}`,
                  );
                }}
              >
                Unpublish
              </button>
            </>
          }
        />
      )}
    </Section>
  );
}

function DangerZone(props: { orgId: string; space: Space }) {
  const { ui } = useHost();
  const [isOpen, setIsOpen] = useState(false);
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<unknown>();
  const remove = async () => {
    try {
      await api("DELETE", `/api/orgs/${props.orgId}/spaces/${props.space.id}`);
      ui.notify({ message: `Deleted ${props.space.name}` });
      navigate(`/orgs/${props.orgId}`);
    } catch (cause) {
      setError(cause);
    }
  };
  return (
    <Section id="danger" title="Danger zone" isDanger>
      <Row label="Delete space">
        <button
          type="button"
          className="btn"
          onClick={() => {
            setConfirm("");
            setIsOpen(true);
          }}
        >
          Delete {props.space.name}…
        </button>
      </Row>
      {isOpen && (
        <Dialog
          role="alertdialog"
          title={`Delete ${props.space.name}?`}
          description="Every page, draft and the site are removed for good."
          onClose={() => setIsOpen(false)}
          onSubmit={() => void remove()}
          footer={
            <>
              <button
                type="button"
                className="btn"
                onClick={() => setIsOpen(false)}
              >
                Cancel
              </button>
              <button
                type="submit"
                className="btn is-danger"
                disabled={confirm !== props.space.name}
              >
                Delete for good
              </button>
            </>
          }
        >
          <label className="field">
            <span>
              Type <span className="mono">{props.space.name}</span> to confirm
            </span>
            <input
              className="input mono"
              value={confirm}
              onChange={(event) => setConfirm(event.target.value)}
            />
          </label>
          {error !== undefined && <ErrorView error={error} />}
        </Dialog>
      )}
    </Section>
  );
}

/**
 * A space's settings, inside the space with the page tree still on the
 * left: General, the sections of plugins, Site, Members, Plugins, Danger
 * zone. `section` (the URL segment after `/settings/`) scrolls to one.
 */
export function SpaceSettings(props: {
  orgId: string;
  space: Space;
  section: string;
  site: SiteStatus | undefined;
  onSiteChange(): void;
  onSpaceChange(): void;
  onPluginsChange(): void;
}) {
  const { ui } = useHost();
  useUiVersion();
  const scope = {
    kind: "space",
    orgId: props.orgId,
    spaceId: props.space.id,
  } as const;
  const pages = ui
    .settingsPages()
    .filter((page) => page.scopes.includes("space"));
  useScrollToSection(props.section, props.site !== undefined);
  return (
    <div className="settings">
      <h1>Settings</h1>
      <GeneralForm
        key={`${props.space.name}\n${props.space.description ?? ""}`}
        orgId={props.orgId}
        space={props.space}
        onChange={props.onSpaceChange}
      />
      {pages.map((page) => {
        const Page = asComponent(page.component);
        return (
          <Section key={page.id} id={page.id} title={page.label}>
            <div className="section-body">
              <Page scope={scope} />
            </div>
          </Section>
        );
      })}
      <SiteSection
        orgId={props.orgId}
        space={props.space}
        status={props.site}
        onChange={props.onSiteChange}
      />
      <Section id="members" title="Members">
        <div className="section-body">
          <SpaceMembers orgId={props.orgId} spaceId={props.space.id} />
        </div>
      </Section>
      <Section id="plugins" title="Plugins">
        <div className="section-body">
          <PluginSettings scope={scope} onChange={props.onPluginsChange} />
        </div>
      </Section>
      <DangerZone orgId={props.orgId} space={props.space} />
    </div>
  );
}
