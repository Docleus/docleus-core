import {
  escapeHtml,
  type SiteLayoutInput,
  type SiteNavItem,
} from "@docleus/sdk";

function navList(
  items: readonly SiteNavItem[],
  url: (path: string) => string,
): string {
  if (items.length === 0) return "";
  const rows = items.map(
    (item) =>
      `<li><a href="${escapeHtml(url(item.path))}">${escapeHtml(item.title)}</a>${navList(item.children, url)}</li>`,
  );
  return `<ul>${rows.join("")}</ul>`;
}

/** The layout of a site whose theme is missing or disabled. */
export function bareLayout({
  page,
  body,
  head,
  slot,
}: SiteLayoutInput): string {
  const title =
    page.title === page.site.name
      ? escapeHtml(page.title)
      : `${escapeHtml(page.title)} - ${escapeHtml(page.site.name)}`;
  return [
    `<!doctype html><html lang="en"><head><meta charset="utf-8">`,
    `<meta name="viewport" content="width=device-width, initial-scale=1">`,
    `<title>${title}</title>${head}</head><body>`,
    `<header>${escapeHtml(page.site.name)}${slot("site.header")}</header>`,
    `<nav aria-label="Pages">${navList(page.nav, (path) => page.url(path))}${slot("site.sidebar")}</nav>`,
    `<main><h1>${escapeHtml(page.title)}</h1>${slot("site.page.header")}${body.html}${slot("site.page.footer")}</main>`,
    `<footer>${slot("site.footer")}</footer></body></html>`,
  ].join("");
}
