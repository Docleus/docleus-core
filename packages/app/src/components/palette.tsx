import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import type { CommandContext, Space, UiSearchResult } from "@docleus/sdk";
import { api } from "../lib/api.ts";
import { useHost } from "../lib/host.tsx";
import type { PageSummary } from "../lib/page-tree.ts";
import { navigate, withBranch } from "../lib/router.ts";
import { useLoad } from "../lib/use-load.ts";

/** A command the current view adds to the palette. */
export interface PaletteCommand {
  readonly id: string;
  readonly label: string;
  readonly keywords?: readonly string[];
  run(): void;
}

interface Row {
  readonly key: string;
  readonly group: string;
  readonly label: string;
  readonly detail?: string;
  run(): void;
}

const MAX_PER_GROUP = 8;
const SEARCH_DELAY_MS = 120;

function matches(query: string, ...texts: readonly (string | undefined)[]) {
  if (query === "") return true;
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const haystack = texts.join(" ").toLowerCase();
  return words.every((word) => haystack.includes(word));
}

function Highlight(props: { text: string; query: string }): ReactNode {
  const words = props.query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return props.text;
  const pattern = new RegExp(
    `(${words.map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})`,
    "gi",
  );
  return props.text
    .split(pattern)
    .map((part, i) => (i % 2 === 1 ? <mark key={i}>{part}</mark> : part));
}

/**
 * The command palette (⌘K): pages of the current space, spaces of the
 * current organization, results of plugin search providers, and commands of
 * the view and of plugins.
 */
export function Palette(props: {
  context: CommandContext;
  commands: readonly PaletteCommand[];
  onClose(): void;
}) {
  const { context } = props;
  const { ui } = useHost();
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  const [found, setFound] = useState<readonly UiSearchResult[]>([]);
  const input = useRef<HTMLInputElement>(null);
  const spaceApi =
    context.orgId !== undefined && context.spaceId !== undefined
      ? `/api/orgs/${context.orgId}/spaces/${context.spaceId}`
      : undefined;
  const pages = useLoad(`palette/pages/${spaceApi ?? ""}`, () =>
    spaceApi
      ? api<{ pages: PageSummary[] }>(
          "GET",
          withBranch(spaceApi, context.branch),
        ).then((result) => result.pages)
      : Promise.resolve([]),
  );
  const spaces = useLoad(`palette/spaces/${context.orgId ?? ""}`, () =>
    context.orgId === undefined
      ? Promise.resolve([])
      : api<{ spaces: Space[] }>("GET", `/api/orgs/${context.orgId}`).then(
          (result) => result.spaces,
        ),
  );

  useEffect(() => {
    input.current?.focus();
    const before = document.activeElement;
    return () => {
      if (before instanceof HTMLElement && before.isConnected) before.focus();
    };
  }, []);

  useEffect(() => {
    const providers = ui.searchProviders();
    if (query.trim() === "" || providers.length === 0) {
      setFound([]);
      return undefined;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => {
      Promise.allSettled(
        providers.map((provider) =>
          provider(query, { ...context, signal: controller.signal }),
        ),
      ).then(
        (results) => {
          if (controller.signal.aborted) return;
          setFound(
            results.flatMap((result) =>
              result.status === "fulfilled" ? result.value : [],
            ),
          );
        },
        () => setFound([]),
      );
    }, SEARCH_DELAY_MS);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [query, ui, context.orgId, context.spaceId, context.branch]);

  const close = props.onClose;
  const rows = useMemo<Row[]>(() => {
    const q = query.trim();
    const go = (href: string) => () => {
      close();
      navigate(href);
    };
    const out: Row[] = [];
    const base =
      context.orgId !== undefined && context.spaceId !== undefined
        ? `/orgs/${context.orgId}/spaces/${context.spaceId}`
        : undefined;
    if (base) {
      out.push(
        ...(pages.data ?? [])
          .filter((page) => matches(q, page.title || "Untitled"))
          .slice(0, MAX_PER_GROUP)
          .map((page) => ({
            key: `page:${page.id}`,
            group: "Pages",
            label: page.title || "Untitled",
            run: go(withBranch(`${base}/pages/${page.id}`, context.branch)),
          })),
      );
    }
    out.push(
      ...(spaces.data ?? [])
        .filter(
          (space) =>
            space.id !== context.spaceId &&
            matches(q, space.name, space.description),
        )
        .slice(0, MAX_PER_GROUP)
        .map((space) => ({
          key: `space:${space.id}`,
          group: "Spaces",
          label: space.name,
          ...(space.description && { detail: space.description }),
          run: go(`/orgs/${space.orgId}/spaces/${space.id}`),
        })),
    );
    out.push(
      ...found.slice(0, MAX_PER_GROUP).map((result) => ({
        key: `found:${result.id}`,
        group: "Search results",
        label: result.label,
        ...(result.detail !== undefined && { detail: result.detail }),
        run: go(result.href),
      })),
    );
    const commands = [
      ...props.commands.map((command) => ({
        id: command.id,
        label: command.label,
        keywords: command.keywords,
        run: command.run,
      })),
      ...ui
        .commands()
        .filter((command) => command.isAvailable?.(context) ?? true)
        .map((command) => ({
          id: command.id,
          label: command.label,
          keywords: command.keywords,
          run: () => void command.run(context),
        })),
    ];
    out.push(
      ...commands
        .filter((command) =>
          matches(q, command.label, ...(command.keywords ?? [])),
        )
        .map((command) => ({
          key: `command:${command.id}`,
          group: "Commands",
          label: command.label,
          run: () => {
            close();
            command.run();
          },
        })),
    );
    return out;
  }, [
    query,
    pages.data,
    spaces.data,
    found,
    props.commands,
    ui,
    context,
    close,
  ]);

  const selected = Math.min(index, Math.max(0, rows.length - 1));
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === "ArrowDown")
      setIndex((selected + 1) % Math.max(1, rows.length));
    else if (event.key === "ArrowUp")
      setIndex((selected - 1 + rows.length) % Math.max(1, rows.length));
    else if (event.key === "Enter") rows[selected]?.run();
    else if (event.key === "Escape") close();
    else return;
    event.preventDefault();
  };

  return createPortal(
    <div
      className="scrim"
      onMouseDown={(event) => event.target === event.currentTarget && close()}
    >
      <div
        className="palette layer"
        role="dialog"
        aria-modal="true"
        aria-label="Search and commands"
      >
        <input
          ref={input}
          className="pq"
          value={query}
          placeholder="Search pages or type a command"
          aria-label="Search pages and commands"
          role="combobox"
          aria-expanded="true"
          aria-controls="palette-results"
          aria-activedescendant={
            rows[selected] ? `palette-${selected}` : undefined
          }
          onChange={(event) => {
            setQuery(event.target.value);
            setIndex(0);
          }}
          onKeyDown={onKeyDown}
        />
        <div
          id="palette-results"
          className="pr menu"
          role="listbox"
          aria-label="Results"
        >
          {rows.map((row, i) => (
            <div key={row.key}>
              {(i === 0 || rows[i - 1]?.group !== row.group) && (
                <div className="mh">{row.group}</div>
              )}
              <button
                type="button"
                id={`palette-${i}`}
                className={`mi${i === selected ? " is-active" : ""}`}
                role="option"
                aria-selected={i === selected}
                onMouseEnter={() => setIndex(i)}
                onClick={row.run}
              >
                <span className="ell">
                  <Highlight text={row.label} query={query} />
                </span>
                {row.detail !== undefined && (
                  <small>
                    <Highlight text={row.detail} query={query} />
                  </small>
                )}
                {i === selected && <span className="k">↵</span>}
              </button>
            </div>
          ))}
          {rows.length === 0 && (
            <p className="muted palette-empty">Nothing matches.</p>
          )}
        </div>
        <div className="pf">
          <span>↑↓ move</span>
          <span>↵ open</span>
          <span>esc close</span>
        </div>
      </div>
    </div>,
    document.body,
  );
}
