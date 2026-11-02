import { slugify } from "@docleus/core-render";
import {
  PAGE_ENTRY_TYPE,
  type Entry,
  type SiteNavItem,
  type SiteNavLink,
} from "@docleus/sdk";

const SEGMENT_PATTERN =
  /^[\p{Letter}\p{Number}](?:[\p{Letter}\p{Number}-]*[\p{Letter}\p{Number}])?$/u;

export interface SpacePages {
  /** Every published page in depth-first order. */
  readonly pages: readonly PlacedPage[];
  readonly nav: readonly SiteNavItem[];
}

export interface PlacedPage {
  readonly entry: Entry;
  readonly path: string;
  readonly prev: SiteNavLink | undefined;
  readonly next: SiteNavLink | undefined;
}

export interface SpaceInput {
  /** `""` or lowercase segments, as in `SiteSpace.path`. */
  readonly path: string;
  readonly entries: readonly Entry[];
}

/** The site-relative directory of a space: `/` or `/api/`. */
export function spaceBase(path: string): string {
  return path === "" ? "/" : `/${path}/`;
}

function slugOf(entry: Entry): string {
  const slug = entry.fields["slug"];
  if (typeof slug !== "string" || slug === "") return slugify(entry.title);
  // A slug becomes one path segment, so anything that could add or escape a segment is slugified.
  return SEGMENT_PATTERN.test(slug) ? slug : slugify(slug);
}

function bySiblingOrder(a: Entry, b: Entry): number {
  return a.order - b.order || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

/**
 * Places the pages of every space of a site. The first top-level page of a
 * space sits at the space's base path; every other page gets
 * `parentPath + slug + "/"`, with `-2`, `-3` on collisions. The root
 * page's children use the base path as their parent. Space base paths are
 * reserved, so a page never takes the path of another space.
 */
export function placePages(spaces: readonly SpaceInput[]): SpacePages[] {
  const used = new Set(spaces.map((space) => spaceBase(space.path)));
  return spaces.map((space) => placeSpace(space, used));
}

function placeSpace(space: SpaceInput, used: Set<string>): SpacePages {
  const pages = space.entries.filter((entry) => entry.type === PAGE_ENTRY_TYPE);
  const ids = new Set(pages.map((entry) => entry.id));
  const children = new Map<string | undefined, Entry[]>();
  for (const entry of pages) {
    const parent =
      entry.parent !== undefined && ids.has(entry.parent)
        ? entry.parent
        : undefined;
    children.set(parent, [...(children.get(parent) ?? []), entry]);
  }
  for (const siblings of children.values()) siblings.sort(bySiblingOrder);

  const base = spaceBase(space.path);
  const order: { entry: Entry; path: string }[] = [];

  function take(parentPath: string, entry: Entry): string {
    const slug = slugOf(entry);
    let path = `${parentPath}${slug}/`;
    for (let n = 2; used.has(path); n++) path = `${parentPath}${slug}-${n}/`;
    used.add(path);
    return path;
  }

  function visit(entry: Entry, path: string): SiteNavItem {
    order.push({ entry, path });
    const items: SiteNavItem[] = [];
    for (const child of children.get(entry.id) ?? []) {
      items.push(visit(child, take(path, child)));
    }
    return { entryId: entry.id, title: entry.title, path, children: items };
  }

  const nav = (children.get(undefined) ?? []).map((entry, index) =>
    visit(entry, index === 0 ? base : take(base, entry)),
  );
  return { nav, pages: link(order) };
}

function link(order: readonly { entry: Entry; path: string }[]): PlacedPage[] {
  const linkOf = (index: number): SiteNavLink | undefined => {
    const at = order[index];
    return at && { title: at.entry.title, path: at.path };
  };
  return order.map(({ entry, path }, index) => ({
    entry,
    path,
    prev: linkOf(index - 1),
    next: linkOf(index + 1),
  }));
}
