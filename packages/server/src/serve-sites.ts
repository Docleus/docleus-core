import type { Context } from "@docleus/kernel";

const SITES_PREFIX = "/sites/";

function notFound(): Response {
  return new Response("Not Found", {
    status: 404,
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "x-content-type-options": "nosniff",
    },
  });
}

function decodeSlug(segment: string): string | undefined {
  try {
    return decodeURIComponent(segment);
  } catch {
    return undefined;
  }
}

/**
 * Answers requests for published sites: every path of a site's custom
 * domain, and `/sites/<org slug>/<site slug>/...` on any other host.
 * `undefined` leaves the request to the API and the frontend.
 */
export async function serveSites(
  ctx: Context,
  request: Request,
): Promise<Response | undefined> {
  const url = new URL(request.url);
  const host = request.headers.get("host") ?? url.host;
  const byDomain = await ctx.sites.findByDomain(host);
  if (byDomain) return ctx.sites.serve(byDomain, request, url.pathname);

  if (!url.pathname.startsWith(SITES_PREFIX)) return undefined;
  const [orgSegment, siteSegment, ...rest] = url.pathname
    .slice(SITES_PREFIX.length)
    .split("/");
  if (orgSegment === undefined || siteSegment === undefined) return undefined;
  const orgSlug = decodeSlug(orgSegment);
  const siteSlug = decodeSlug(siteSegment);
  if (orgSlug === undefined || siteSlug === undefined) return notFound();
  const site = await ctx.sites.findBySlug(orgSlug, siteSlug);
  if (!site) return notFound();
  if (rest.length === 0) {
    return new Response(null, {
      status: 308,
      headers: { location: `${url.pathname}/${url.search}` },
    });
  }
  return ctx.sites.serve(site, request, `/${rest.join("/")}`);
}
