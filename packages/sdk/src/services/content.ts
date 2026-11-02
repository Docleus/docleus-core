import type { z } from "zod";
import type { BlockNode } from "./blocks.ts";

/** An organization: the owner of spaces, sites and members. */
export interface Org {
  readonly id: string;
  readonly slug: string;
  readonly name: string;
}

/** A space of an organization, holding one tree of entries per branch. */
export interface Space {
  readonly id: string;
  readonly orgId: string;
  readonly slug: string;
  readonly name: string;
  /** One line shown on the space's card. Core always sets it, empty when unset. */
  readonly description?: string;
}

/** The fields of an organization that {@link ContentService.updateOrg} changes. */
export interface OrgUpdate {
  readonly slug?: string;
  readonly name?: string;
}

/** The fields of a space that {@link ContentService.updateSpace} changes. */
export interface SpaceUpdate {
  readonly slug?: string;
  readonly name?: string;
  readonly description?: string;
}

/** One event of the append-only content log. */
export interface LogEntry {
  readonly seq: number;
  readonly type: string;
  readonly payload: unknown;
  readonly at: number;
}

/** The built-in entry type: a page whose body is a block tree. */
export const PAGE_ENTRY_TYPE = "page";

/**
 * How entries of a type are validated, registered with `content.registerEntryType`.
 */
export interface EntryTypeDefinition {
  /** Validates `fields` on commit. Defaults to accepting any object. */
  readonly fields?: z.ZodType;
  /** Whether entries of this type carry a block-tree `body`. */
  readonly hasBody: boolean;
}

/** One entry as stored in a revision. Identical contents share one stored copy. */
export interface EntryContent {
  readonly type: string;
  readonly title: string;
  /** The parent entry's id, or `undefined` at the top of the tree. */
  readonly parent: string | undefined;
  /** Position among siblings, ascending. */
  readonly order: number;
  readonly fields: Readonly<Record<string, unknown>>;
  /** A `doc` block, for entry types that have a body. */
  readonly body?: BlockNode;
  /** Data other plugins keep with the entry, keyed by plugin name (for example Markdown formatting). */
  readonly meta?: Readonly<Record<string, unknown>>;
}

/** An entry of a revision with its id. */
export interface Entry extends EntryContent {
  readonly id: string;
}

/** The branch every space has. Sites, search and other projections read it. */
export const MAIN_BRANCH = "main";

/**
 * A line of revisions in a space. `main` always exists; other branches are
 * created from a revision and can be deleted. Branch names match
 * `^[a-z0-9][a-z0-9._/-]{0,99}$`.
 */
export interface Branch {
  readonly spaceId: string;
  readonly name: string;
  /** `undefined` while the branch has no revision (an empty space). */
  readonly head: string | undefined;
  /**
   * The revision of `main` the branch was created from or last rebased
   * onto: the base of a three-way merge back into `main`. Always
   * `undefined` for `main`.
   */
  readonly base: string | undefined;
  readonly createdAt: number;
}

/** An immutable snapshot: entry id to the hash of that entry's content. */
export interface Revision {
  readonly id: string;
  readonly spaceId: string;
  /** The branch the revision was committed to. */
  readonly branch: string;
  /** `undefined` for the first revision of a space. */
  readonly parent: string | undefined;
  readonly entries: Readonly<Record<string, string>>;
  readonly message: string;
  /** The user who made the change; `undefined` for system commits such as migrations. */
  readonly author: string | undefined;
  /** For a merge, the head of the branch that was merged in. */
  readonly merged: string | undefined;
  readonly at: number;
}

/** Input of `content.commit`. */
export interface CommitInput {
  readonly spaceId: string;
  /** Defaults to {@link MAIN_BRANCH}. Other branches must exist. */
  readonly branch?: string;
  /** The branch head this commit is based on; a different current head rejects the commit. */
  readonly parent: string | undefined;
  /** Entries to add or replace. Omitted entries carry over from `parent`. */
  readonly put?: Readonly<Record<string, EntryContent>>;
  readonly remove?: readonly string[];
  readonly message: string;
  /** The user id the change is attributed to. */
  readonly author?: string;
  /** For a merge, the head of the branch being merged in. */
  readonly merged?: string;
  /** Not for `main`: sets the branch's base to this `main` revision in the same transaction (a rebase). */
  readonly rebase?: string;
}

/** Input of the `content/pre-commit` hook: the commit as it will be written. */
export interface PreCommitInput {
  readonly space: Space;
  /** The commit with `branch` filled in. */
  readonly commit: CommitInput & { readonly branch: string };
  /**
   * Set by {@link ContentService.checkCommit}: nothing is written, so
   * listeners should only decide, without side effects.
   */
  readonly isDryRun?: boolean;
}

/** Input of the `content/flush` event. */
export interface ContentFlushInput {
  readonly spaceId: string;
  readonly branch: string;
}

/** Where a {@link MergeCheck} stands. `pending` and `failure` both block a required check. */
export type MergeCheckStatus = "pending" | "success" | "failure";

/** One check a plugin reports for a change request's head. */
export interface MergeCheck {
  /** Namespaced and stable across runs, such as `acme.lint`; one entry per name. */
  readonly name: string;
  /** Short, human-readable label shown in the change request. */
  readonly title: string;
  readonly status: MergeCheckStatus;
  /** A required check must be `success` before the change request can merge. */
  readonly isRequired: boolean;
  /** One line explaining the status. */
  readonly summary?: string;
  /** Where to see details, such as a CI run. */
  readonly url?: string;
}

/** Input of the `change-request/checks` event. */
export interface ChangeRequestChecksInput {
  readonly spaceId: string;
  /** The change request number, unique per space. */
  readonly number: number;
  readonly title: string;
  /** The change request's branch. */
  readonly branch: string;
  /** The `main` revision the branch starts from. */
  readonly base: string | undefined;
  /** The branch head the checks are for; a new commit asks again. */
  readonly head: string | undefined;
  /** Adds a check result. Call it once per check, before the listener settles. */
  report(check: MergeCheck): void;
}

/** The entries of a revision, keyed by entry id. */
export type EntrySet = Readonly<Record<string, EntryContent>>;

/** The parts of an entry that merge on their own. */
export type EntryField = "type" | "title" | "position" | "fields" | "meta";

/** Where a block sits: its parent block and the sibling right before it. */
export interface BlockPosition {
  readonly parent: string;
  /** `undefined` for the first child. */
  readonly after: string | undefined;
}

/**
 * A change both sides made differently. `ours` is the target (usually
 * `main`), `theirs` the branch being merged in; `undefined` means the
 * side deleted it (or, for `base`, that it did not exist). Ids are
 * derived from what conflicts (`block:<entryId>:<blockId>` and so on), so
 * the same conflict keeps its id across repeated merges.
 *
 * An id is `<kind>:<subject>:<digest>`, where the subject is
 * `<entryId>:<blockId>` for blocks, `<entryId>:<field>` for `entry`,
 * `<entryId>` for `entry-deleted` and the sorted `entryIds` joined by `,`
 * for `tree`, and the digest is a hash of the three versions that does
 * not depend on which side is `ours`. An id changes when a side's version
 * changes, so a stored resolution never applies to a different conflict.
 * Merging with the sides swapped reports the same ids with `ours` and
 * `theirs` swapped.
 *
 * - `entry`: an entry field. `position` values are `{ parent, order }`;
 *   `fields` and `meta` merge per top-level key and conflict as a whole
 *   object; the other values are the field's value.
 * - `entry-deleted`: one side deleted the entry, the other changed it
 *   (including blocks in its body, or entries below it).
 * - `block`: a block's own content (`type`, `v`, `attrs`, `inline`; its
 *   children are merged separately and left out), or a deletion on one
 *   side against a change in it or below it on the other. For the body's
 *   root block, `blockId` is the root's id in `base` (or, when the body
 *   is new, the smaller of the sides' root ids).
 * - `block-position`: both sides moved a block to different places,
 *   reordered siblings in ways that contradict each other (one conflict
 *   per block involved), or the moves would nest a block inside itself.
 *   Inserting or deleting siblings never conflicts with a reorder.
 *   `after` is the previous sibling on that side.
 * - `tree`: the merged entry parents would form a cycle or point at a
 *   removed entry; `entryIds` are the entries involved. Resolved with
 *   `take`, which uses that side's version (or absence) of each of them.
 *
 * Deletes that do not conflict also remove everything below the deleted
 * entry or block. Unresolved conflicts of every kind still leave a valid
 * result: parents exist, there are no cycles and block ids stay unique.
 */
export type MergeConflict =
  | {
      readonly id: string;
      readonly kind: "entry";
      readonly entryId: string;
      readonly field: EntryField;
      readonly base: unknown;
      readonly ours: unknown;
      readonly theirs: unknown;
    }
  | {
      readonly id: string;
      readonly kind: "entry-deleted";
      readonly entryId: string;
      readonly base: EntryContent | undefined;
      readonly ours: EntryContent | undefined;
      readonly theirs: EntryContent | undefined;
    }
  | {
      readonly id: string;
      readonly kind: "block";
      readonly entryId: string;
      readonly blockId: string;
      readonly base: BlockNode | undefined;
      readonly ours: BlockNode | undefined;
      readonly theirs: BlockNode | undefined;
    }
  | {
      readonly id: string;
      readonly kind: "block-position";
      readonly entryId: string;
      readonly blockId: string;
      readonly base: BlockPosition | undefined;
      readonly ours: BlockPosition | undefined;
      readonly theirs: BlockPosition | undefined;
    }
  | {
      readonly id: string;
      readonly kind: "tree";
      readonly entryIds: readonly string[];
    };

/**
 * How to settle one conflict: take one side, or give the value by hand.
 * A value is an entry field's value for `entry`, an `EntryContent` or
 * `null` (delete) for `entry-deleted`, and a `BlockNode` without
 * `content` or `null` (delete) for `block`. `block-position` and `tree`
 * take a side only. An invalid value throws `content/invalid-resolution`.
 *
 * For `entry`, a `position` value is `{ parent, order }` with `parent`
 * `null` or left out for a top-level entry, and a `meta` value may be
 * `null` to remove it. A `block` value keeps the block's id (only the
 * root's may change), and `null` for the root removes the whole body.
 * Taking a side settles a `fields` or `meta` conflict
 * only for the keys both sides changed; other keys still merge.
 */
export type MergeResolution =
  { readonly take: "ours" | "theirs" } | { readonly value: unknown };

/** Input of `content.merge`: the three sides of a three-way merge. */
export interface MergeInput {
  readonly base: EntrySet;
  readonly ours: EntrySet;
  readonly theirs: EntrySet;
  /** Keyed by {@link MergeConflict.id}. Resolutions for conflicts that no longer occur are ignored. */
  readonly resolutions?: Readonly<Record<string, MergeResolution>>;
}

/** The outcome of a three-way merge. */
export interface MergeResult {
  /** The merged entries. Unresolved conflicts keep `ours`. */
  readonly entries: EntrySet;
  /** Unresolved conflicts, in a stable order. Empty when the merge is clean. */
  readonly conflicts: readonly MergeConflict[];
}

/** The content-log type written for every commit. */
export const REVISION_COMMITTED = "revision/committed";

/** Payload of a {@link REVISION_COMMITTED} log entry. */
export interface RevisionCommitted {
  readonly spaceId: string;
  readonly revision: string;
  readonly parent: string | undefined;
  /** Missing in entries written before branches existed, which were all on `main`. */
  readonly branch?: string;
  /** Entries added or whose content changed. */
  readonly changed: readonly string[];
  readonly removed: readonly string[];
}

/**
 * Derived state built from the content log, such as a search index or
 * navigation. It can be rebuilt from scratch at any time.
 */
export interface Projection {
  /** Unique; also the key its progress is stored under. */
  readonly name: string;
  /** Clears the derived state before a rebuild. */
  reset(): Promise<void>;
  /** Applies one entry. Entries arrive once each, in sequence order. */
  apply(entry: LogEntry): Promise<void>;
}

/**
 * Organizations, spaces, branches, revisions, three-way merges and the append-only content log.
 *
 * @stability experimental
 */
export interface ContentService {
  createOrg(input: { slug: string; name: string }): Promise<Org>;
  getOrg(id: string): Promise<Org | undefined>;
  listOrgs(): Promise<Org[]>;
  createSpace(input: {
    orgId: string;
    slug: string;
    name: string;
    description?: string;
  }): Promise<Space>;
  listSpaces(orgId: string): Promise<Space[]>;
  /**
   * Renames an organization or changes its slug, and appends `org/updated`.
   * Throws `content/org-not-found`, `content/invalid-slug` or `content/slug-taken`.
   */
  updateOrg(id: string, update: OrgUpdate): Promise<Org>;
  /**
   * Deletes an organization and every space in it, appending `space/deleted`
   * for each space and then `org/deleted`. Deleted organizations and spaces
   * disappear from every read and their slugs become free; their revisions
   * stay in storage, so the content log keeps resolving. Throws
   * `content/org-not-found`.
   */
  deleteOrg(id: string): Promise<void>;
  /**
   * Changes a space's name, slug or description, and appends `space/updated`.
   * Throws `content/space-not-found`, `content/invalid-slug` or `content/slug-taken`.
   */
  updateSpace(id: string, update: SpaceUpdate): Promise<Space>;
  /**
   * Deletes a space and appends `space/deleted`; afterwards it is gone from
   * `listSpaces` and commits to it fail with `content/space-not-found`.
   * Throws `content/space-not-found`.
   */
  deleteSpace(id: string): Promise<void>;
  /** Appends a durable event. Sequence numbers start at 1 and increase by exactly 1. */
  append(type: string, payload: unknown): Promise<LogEntry>;
  /** Entries after `afterSeq` in sequence order, at most `limit`. */
  readLog(options?: { afterSeq?: number; limit?: number }): Promise<LogEntry[]>;

  /** Throws when `type` is already registered. The returned function unregisters it. */
  registerEntryType(type: string, definition: EntryTypeDefinition): () => void;
  /**
   * Writes a new revision and makes it the space's head, then appends
   * {@link REVISION_COMMITTED}. Rejects when `parent` is not the current
   * head, and when a put entry's type is unknown or its fields are invalid.
   * Bodies are stored migrated to their blocks' current versions.
   *
   * Before writing, runs the `content/pre-commit` hook (filtered to the
   * space's scope), which can reject the commit by throwing or rewrite it.
   */
  commit(input: CommitInput): Promise<Revision>;
  /**
   * Runs the `content/pre-commit` hook for `input` with `isDryRun` set,
   * without writing; rejects as `commit` would for a rejected commit.
   * Callers use it to learn whether a user may write to a branch directly.
   */
  checkCommit(input: CommitInput): Promise<void>;
  /** The head of `branch` (default {@link MAIN_BRANCH}). */
  head(spaceId: string, branch?: string): Promise<Revision | undefined>;
  /**
   * The heads of `branch` in several spaces at once, in the order of
   * `spaceIds`; for listings that would otherwise read one head per space.
   */
  heads(
    spaceIds: readonly string[],
    branch?: string,
  ): Promise<(Revision | undefined)[]>;
  /**
   * Creates a branch whose head and base are `from`, a revision of `main`
   * (default: the head of `main`). Throws when the name is taken or
   * invalid, or names `main`.
   */
  createBranch(input: {
    spaceId: string;
    name: string;
    from?: string;
  }): Promise<Branch>;
  /** `main` is returned even before its first revision. */
  getBranch(spaceId: string, name: string): Promise<Branch | undefined>;
  /** `main` first, then the others by name. */
  listBranches(spaceId: string): Promise<Branch[]>;
  /** Its revisions stay readable. Throws for `main`. */
  deleteBranch(spaceId: string, name: string): Promise<void>;
  /**
   * Three-way merge of entry sets, keyed by entry id and, within bodies,
   * by block id. Where only one side changed something, that side wins;
   * where both changed it differently, the result keeps `ours` and
   * reports a conflict. Pure and synchronous.
   *
   * Identical changes on both sides are not conflicts, and values compare
   * by content, ignoring object key order. Sibling order merges per pair,
   * so inserts and deletes on one side combine with a reorder on the
   * other; siblings both sides inserted at the same spot come out in the
   * same order whichever side is `ours`. Throws
   * `content/invalid-merge-input` when a body repeats a block id.
   */
  merge(input: MergeInput): MergeResult;
  getRevision(id: string): Promise<Revision | undefined>;
  /** The entry as of `revision`, its body migrated in memory to current block versions. */
  getEntry(revision: string, entryId: string): Promise<Entry | undefined>;
  listEntries(revision: string): Promise<Entry[]>;
  /**
   * Commits the space's head with every body migrated to current block
   * versions. Returns the new revision, or `undefined` when nothing changed.
   */
  migrate(spaceId: string): Promise<Revision | undefined>;

  /**
   * Registers a projection and replays the log it has not yet seen. New log
   * entries are applied as they are appended. The returned function
   * unregisters it; its stored progress stays.
   */
  registerProjection(projection: Projection): () => void;
  /**
   * Applies every entry appended so far that `name` has not applied, and
   * resolves once it has. Rejects when an apply throws; the projection's
   * progress stops before that entry, so a later call retries it.
   */
  catchUp(name: string): Promise<void>;
  /** Resets `name` and replays the whole log into it. */
  rebuild(name: string): Promise<void>;
}
