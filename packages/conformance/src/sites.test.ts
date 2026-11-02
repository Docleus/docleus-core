import type {
  ContentService,
  InstallationsService,
  Org,
  Revision,
  Site,
  SitesService,
  Space,
} from "@docleus/sdk";
import { describe, expect, it } from "vitest";
import { sitesConformanceSuite, type SitesSubject } from "./sites.ts";

const notImplemented = (): never => {
  throw new Error("not implemented");
};

/** Violates domain normalization: stores and matches domains exactly as given. */
function createBrokenSitesSubject(): SitesSubject {
  const orgs: Org[] = [];
  const spaces: Space[] = [];
  const sites: Site[] = [];
  const content = {
    async createOrg(input) {
      const org = { id: `org${orgs.length}`, ...input };
      orgs.push(org);
      return org;
    },
    async createSpace(input) {
      const space = { id: `space${spaces.length}`, ...input };
      spaces.push(space);
      return space;
    },
    async commit(input): Promise<Revision> {
      return {
        id: "rev",
        spaceId: input.spaceId,
        branch: input.branch ?? "main",
        parent: input.parent,
        entries: {},
        message: input.message,
        author: input.author,
        merged: input.merged,
        at: 0,
      };
    },
  } as Partial<ContentService> as ContentService;
  const service: SitesService = {
    async create(input) {
      const site: Site = {
        id: `site${sites.length}`,
        orgId: input.orgId,
        slug: input.slug,
        name: input.name,
        theme: input.theme,
        domain: input.domain,
        spaces: input.spaces,
        active: undefined,
      };
      sites.push(site);
      return site;
    },
    async get(id) {
      return sites.find((site) => site.id === id);
    },
    async findByDomain(host) {
      return sites.find((site) => site.domain === host);
    },
    async update(id, input) {
      const index = sites.findIndex((site) => site.id === id);
      const current = sites[index];
      if (!current) throw new Error("no site");
      const next: Site = {
        ...current,
        domain: input.domain === null ? undefined : input.domain,
      };
      sites[index] = next;
      return next;
    },
    list: notImplemented,
    remove: notImplemented,
    findBySlug: notImplemented,
    publish: notImplemented,
    listPublications: notImplemented,
    getPublication: notImplemented,
    activate: notImplemented,
    readArtifact: notImplemented,
    serve: notImplemented,
  };
  return {
    sites: service,
    content,
    installations: {} as InstallationsService,
    loadPlugin: notImplemented,
  };
}

describe("a deliberately broken sites implementation", () => {
  it("fails the domain normalization invariant the suite is meant to catch", async () => {
    const invariant = sitesConformanceSuite.invariants.find(
      (candidate) =>
        candidate.name ===
        "domains are normalized to a lowercase host name without a port",
    );
    if (!invariant) throw new Error("expected the invariant to exist");
    await expect(
      Promise.resolve(invariant.check(createBrokenSitesSubject())),
    ).rejects.toThrow(/docs\.example\.com/);
  });
});
