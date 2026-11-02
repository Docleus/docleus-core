import { useState } from "react";
import { api } from "../lib/api.ts";
import { fullTime, relativeTime, type Site } from "@docleus/sdk";
import { plural } from "../lib/format.ts";
import { useHost } from "../lib/host.tsx";
import { useLoad, type Loaded } from "../lib/use-load.ts";
import { ErrorView } from "./error-view.tsx";
import { Popover, anchorOf, useLayer, type Anchor } from "./layers.tsx";
import { Link } from "./link.tsx";

export interface PendingPage {
  readonly id: string;
  readonly title: string;
  readonly kind: "A" | "M" | "D";
}

export interface SiteHistoryEntry {
  readonly publication: string;
  readonly revision: string | null;
  readonly at: number;
  readonly by: string | null;
  readonly byName: string | null;
}

/** `GET /api/orgs/:orgId/spaces/:spaceId/site`. */
export interface SiteStatus {
  readonly site: (Site & { readonly url: string }) | null;
  readonly canPublish: boolean;
  readonly head: string | null;
  readonly live?: {
    readonly publication: string;
    readonly revision: string | null;
    readonly at: number;
  } | null;
  readonly pending?: readonly PendingPage[];
  readonly history?: readonly SiteHistoryEntry[];
}

export function useSiteStatus(
  orgId: string,
  spaceId: string,
  version: number,
): Loaded<SiteStatus> {
  return useLoad(`site/${orgId}/${spaceId}#${version}`, () =>
    api<SiteStatus>("GET", `/api/orgs/${orgId}/spaces/${spaceId}/site`),
  );
}

/** Whether main has something the site does not serve. */
export function isAhead(status: SiteStatus | undefined): boolean {
  if (!status?.site) return false;
  return status.live?.revision !== status.head && status.head !== null;
}

export async function publishSite(orgId: string, siteId: string) {
  await api("POST", `/api/orgs/${orgId}/sites/${siteId}/publications`);
}

/** Creates the site of a space (the space at its root) and publishes it. */
export async function createAndPublish(input: {
  orgId: string;
  spaceId: string;
  slug: string;
  name: string;
}): Promise<void> {
  const { site } = await api<{ site: Site }>(
    "POST",
    `/api/orgs/${input.orgId}/sites`,
    {
      slug: input.slug,
      name: input.name,
      spaces: [{ spaceId: input.spaceId, path: "" }],
    },
  );
  await publishSite(input.orgId, site.id);
}

/**
 * The live state in a space's top bar: a pill that opens the site popover,
 * and Publish while main is ahead of the site (or before the first publish).
 */
export function SiteControls(props: {
  orgId: string;
  orgSlug: string;
  spaceId: string;
  spaceSlug: string;
  spaceName: string;
  status: SiteStatus | undefined;
  hasPages: boolean;
  isPrimary: boolean;
  settingsHref: string;
  onPublished(): void;
}) {
  const { status } = props;
  const popover = useLayer();
  if (!status) return null;
  const site = status.site;
  if (!site && !status.canPublish) return null;
  const ahead = isAhead(status);
  const pending = status.pending ?? [];
  const showPublish = status.canPublish && (site ? ahead : props.hasPages);
  const open = (event: { currentTarget: EventTarget; type: string }) =>
    popover.show(anchorOf(event), undefined);

  return (
    <>
      <button
        type="button"
        className={`tag bar-live ${site?.active ? "is-solid" : "is-muted"}`}
        aria-haspopup="dialog"
        title={
          site?.active && status.live
            ? `Published ${fullTime(status.live.at)}`
            : site
              ? "Site and publish history"
              : "Publish this space"
        }
        onClick={open}
      >
        {site?.active ? "Live" : "Not published"}
      </button>
      {showPublish && (
        <button
          type="button"
          className={`btn bar-publish${props.isPrimary ? " is-primary" : ""}`}
          aria-haspopup="dialog"
          onClick={open}
        >
          Publish
          {pending.length > 0 && (
            <span
              className="mono"
              aria-label={plural(pending.length, "changed page")}
            >
              {pending.length}
            </span>
          )}
        </button>
      )}
      {popover.open &&
        (site ? (
          <SitePopover
            {...props}
            site={site}
            status={status}
            anchor={popover.open.anchor}
            onClose={popover.close}
          />
        ) : (
          <FirstPublish
            {...props}
            anchor={popover.open.anchor}
            onClose={popover.close}
          />
        ))}
    </>
  );
}

function SitePopover(props: {
  orgId: string;
  site: Site & { readonly url: string };
  status: SiteStatus;
  spaceName: string;
  settingsHref: string;
  anchor: Anchor;
  onClose(): void;
  onPublished(): void;
}) {
  const { site, status } = props;
  const { ui } = useHost();
  const [isBusy, setIsBusy] = useState(false);
  const [error, setError] = useState<unknown>();
  const pending = status.pending ?? [];
  const last = status.history?.[0];
  const isCurrent = !isAhead(status);
  const publish = async () => {
    setIsBusy(true);
    setError(undefined);
    try {
      await publishSite(props.orgId, site.id);
      props.onClose();
      props.onPublished();
      ui.notify({ message: `Published ${props.spaceName}` });
    } catch (cause) {
      setError(cause);
    } finally {
      setIsBusy(false);
    }
  };
  return (
    <Popover
      anchor={props.anchor}
      label="Publish"
      title={`${props.spaceName} site`}
      onClose={props.onClose}
      footer={
        <>
          <Link
            className="btn is-quiet"
            href={props.settingsHref}
            onClick={props.onClose}
          >
            History and domains
          </Link>
          {status.canPublish && (
            <button
              type="button"
              className="btn is-primary"
              disabled={isCurrent || isBusy}
              onClick={() => void publish()}
            >
              {isBusy ? "Publishing…" : "Publish now"}
            </button>
          )}
        </>
      }
    >
      <div className="pb">
        <a
          className="mono"
          href={site.domain ? `https://${site.domain}/` : site.url}
          target="_blank"
          rel="noreferrer"
        >
          {site.domain ?? site.url}
        </a>
        {last && (
          <p className="muted pop-line">
            Published {relativeTime(last.at)}
            {last.byName ? ` by ${last.byName}` : ""}
          </p>
        )}
      </div>
      <div className="pb">
        {!site.active ? (
          <p className="pop-line">Nothing is published yet.</p>
        ) : isCurrent ? (
          <p className="pop-line">The site shows every merged change.</p>
        ) : pending.length === 0 ? (
          <p className="pop-line">
            The site shows an older version. Publish to bring it up to date.
          </p>
        ) : (
          <>
            <p className="pop-line">
              <strong>{plural(pending.length, "page")}</strong> changed since
              the last publish.
            </p>
            <ul className="plist">
              {pending.slice(0, 8).map((page) => (
                <li key={page.id}>
                  <span className={`chl is-${page.kind.toLowerCase()}`}>
                    {page.kind}
                  </span>
                  <span className="ell">{page.title || "Untitled"}</span>
                </li>
              ))}
            </ul>
          </>
        )}
        {error !== undefined && <ErrorView error={error} />}
      </div>
    </Popover>
  );
}

function FirstPublish(props: {
  orgId: string;
  orgSlug: string;
  spaceId: string;
  spaceSlug: string;
  spaceName: string;
  hasPages: boolean;
  anchor: Anchor;
  onClose(): void;
  onPublished(): void;
}) {
  const { ui } = useHost();
  const [slug, setSlug] = useState(props.spaceSlug);
  const [isBusy, setIsBusy] = useState(false);
  const [error, setError] = useState<unknown>();
  const publish = async () => {
    setIsBusy(true);
    setError(undefined);
    try {
      await createAndPublish({
        orgId: props.orgId,
        spaceId: props.spaceId,
        slug,
        name: props.spaceName,
      });
      props.onClose();
      props.onPublished();
      ui.notify({ message: `Published ${props.spaceName}` });
    } catch (cause) {
      setError(cause);
    } finally {
      setIsBusy(false);
    }
  };
  return (
    <Popover
      anchor={props.anchor}
      label="Publish this space"
      title="Publish this space"
      onClose={props.onClose}
      footer={
        <>
          <button
            type="button"
            className="btn is-quiet"
            onClick={props.onClose}
          >
            Cancel
          </button>
          <button
            type="button"
            className="btn is-primary"
            disabled={!props.hasPages || slug === "" || isBusy}
            onClick={() => void publish()}
          >
            {isBusy ? "Publishing…" : "Publish"}
          </button>
        </>
      }
    >
      <div className="pb">
        <label className="field">
          <span>Address</span>
          <span className="slug-field">
            <span className="muted mono">/sites/{props.orgSlug}/</span>
            <input
              className="input mono"
              value={slug}
              aria-label="Site address"
              onChange={(event) => setSlug(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") void publish();
              }}
            />
          </span>
        </label>
        {error !== undefined && <ErrorView error={error} />}
      </div>
    </Popover>
  );
}
