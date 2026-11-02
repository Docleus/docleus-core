import {
  MAIN_BRANCH,
  type BlocksService,
  type Branch,
  type ContentService,
  type LogEntry,
  type Org,
  type Revision,
  type Space,
} from "@docleus/sdk";
import { describe, expect, it } from "vitest";
import { contentConformanceSuite, type ContentSubject } from "./content.ts";

const notImplemented = (): never => {
  throw new Error("not implemented");
};

const blocks: BlocksService = {
  register: () => () => undefined,
  isKnown: () => false,
  read: (node) => node,
  text: () => "",
};

/**
 * Violates "start at 1 and increase by exactly 1": numbers the log from 0
 * in steps of 10. Also violates branch-name validation: `createBranch`
 * accepts any name, including `main`. And `deleteSpace` forgets to hide the
 * space from `listSpaces`. And `heads` ignores the order it was asked in.
 */
function createBrokenContentService(): ContentSubject {
  const orgs: Org[] = [];
  const spaces: Space[] = [];
  const log: LogEntry[] = [];
  const branches: Branch[] = [];
  const revisions: Revision[] = [];
  const content: ContentService = {
    async createOrg(input) {
      const org = { id: String(orgs.length), ...input };
      orgs.push(org);
      return org;
    },
    async getOrg(id) {
      return orgs.find((org) => org.id === id);
    },
    async listOrgs() {
      return [...orgs];
    },
    async createSpace(input) {
      const space = { id: String(spaces.length), ...input };
      spaces.push(space);
      return space;
    },
    async listSpaces(orgId) {
      return spaces.filter((space) => space.orgId === orgId);
    },
    updateOrg: notImplemented,
    deleteOrg: notImplemented,
    updateSpace: notImplemented,
    async deleteSpace(id) {
      await content.append("space/deleted", { spaceId: id });
    },
    async append(type, payload) {
      const entry = { seq: log.length * 10, type, payload, at: Date.now() };
      log.push(entry);
      return entry;
    },
    async readLog({ afterSeq = 0, limit } = {}) {
      return log.filter((entry) => entry.seq > afterSeq).slice(0, limit);
    },
    registerEntryType: notImplemented,
    async commit(input) {
      const revision: Revision = {
        id: `r${revisions.length}`,
        spaceId: input.spaceId,
        branch: MAIN_BRANCH,
        parent: input.parent,
        entries: {},
        message: input.message,
        author: undefined,
        merged: undefined,
        at: Date.now(),
      };
      revisions.push(revision);
      return revision;
    },
    checkCommit: notImplemented,
    async head(spaceId) {
      return revisions.findLast((revision) => revision.spaceId === spaceId);
    },
    async heads() {
      return revisions.toReversed();
    },
    getRevision: notImplemented,
    getEntry: notImplemented,
    listEntries: notImplemented,
    migrate: notImplemented,
    async createBranch({ spaceId, name }) {
      const branch = {
        spaceId,
        name,
        head: undefined,
        base: undefined,
        createdAt: Date.now(),
      };
      branches.push(branch);
      return branch;
    },
    async getBranch(spaceId, name) {
      if (name === MAIN_BRANCH) {
        return {
          spaceId,
          name,
          head: undefined,
          base: undefined,
          createdAt: 0,
        };
      }
      return branches.find(
        (branch) => branch.spaceId === spaceId && branch.name === name,
      );
    },
    listBranches: notImplemented,
    deleteBranch: notImplemented,
    merge: notImplemented,
    registerProjection: notImplemented,
    catchUp: notImplemented,
    rebuild: notImplemented,
  };
  return { content, blocks };
}

describe("a deliberately broken content implementation", () => {
  it("fails the log sequence invariant the suite is meant to catch", async () => {
    const invariant = contentConformanceSuite.invariants.find(
      (candidate) =>
        candidate.name ===
        "log sequence numbers start at 1 and increase by exactly 1",
    );
    if (!invariant) throw new Error("expected the invariant to exist");
    await expect(
      Promise.resolve(invariant.check(createBrokenContentService())),
    ).rejects.toThrow();
  });
});

describe("a deliberately broken branch implementation", () => {
  it("fails the branch-name validation invariant the suite is meant to catch", async () => {
    const invariant = contentConformanceSuite.invariants.find((candidate) =>
      candidate.name.startsWith("createBranch rejects invalid or taken names"),
    );
    if (!invariant) throw new Error("expected the invariant to exist");
    await expect(
      Promise.resolve(invariant.check(createBrokenContentService())),
    ).rejects.toThrow();
  });
});

describe("a deliberately broken space deletion", () => {
  it("fails the space deletion invariant the suite is meant to catch", async () => {
    const invariant = contentConformanceSuite.invariants.find((candidate) =>
      candidate.name.startsWith("a deleted space disappears"),
    );
    if (!invariant) throw new Error("expected the invariant to exist");
    await expect(
      Promise.resolve(invariant.check(createBrokenContentService())),
    ).rejects.toThrow();
  });
});

describe("a deliberately broken heads", () => {
  it("fails the heads invariant the suite is meant to catch", async () => {
    const invariant = contentConformanceSuite.invariants.find((candidate) =>
      candidate.name.startsWith("heads returns each space's head"),
    );
    if (!invariant) throw new Error("expected the invariant to exist");
    await expect(
      Promise.resolve(invariant.check(createBrokenContentService())),
    ).rejects.toThrow();
  });
});
