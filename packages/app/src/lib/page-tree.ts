export interface PageSummary {
  readonly id: string;
  readonly title: string;
  readonly parent: string | null;
  readonly order: number;
  /** The page's content hash at the branch it was listed from. */
  readonly hash?: string;
}

export interface TreeNode {
  readonly page: PageSummary;
  readonly children: TreeNode[];
}

const byOrder = (a: PageSummary, b: PageSummary) =>
  a.order - b.order || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

export function buildTree(pages: readonly PageSummary[]): TreeNode[] {
  const children = new Map<string | null, PageSummary[]>();
  for (const page of pages) {
    children.set(page.parent, [...(children.get(page.parent) ?? []), page]);
  }
  const build = (parent: string | null): TreeNode[] =>
    (children.get(parent) ?? [])
      .toSorted(byOrder)
      .map((page) => ({ page, children: build(page.id) }));
  return build(null);
}

export function siblingsOf(
  pages: readonly PageSummary[],
  page: PageSummary,
): PageSummary[] {
  return pages
    .filter((other) => other.parent === page.parent)
    .toSorted(byOrder);
}

/**
 * The order that places `page` one step up (`-1`) or down (`1`) among its
 * siblings, or undefined when it is already first or last.
 */
export function orderForStep(
  pages: readonly PageSummary[],
  page: PageSummary,
  step: -1 | 1,
): number | undefined {
  const siblings = siblingsOf(pages, page);
  const index = siblings.findIndex((other) => other.id === page.id);
  const target = siblings[index + step];
  if (index < 0 || !target) return undefined;
  const beyond = siblings[index + 2 * step];
  return beyond ? (target.order + beyond.order) / 2 : target.order + step;
}

/** `page` and every page under it. */
export function subtreeIds(
  pages: readonly PageSummary[],
  id: string,
): Set<string> {
  const out = new Set([id]);
  let isGrowing = true;
  while (isGrowing) {
    isGrowing = false;
    for (const page of pages) {
      if (page.parent !== null && out.has(page.parent) && !out.has(page.id)) {
        out.add(page.id);
        isGrowing = true;
      }
    }
  }
  return out;
}
