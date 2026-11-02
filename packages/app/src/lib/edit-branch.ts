import { MAIN_BRANCH } from "@docleus/sdk";

/** Decides which branch the writes of one space visit go to. */
export interface EditBranchGate {
  /**
   * Runs `action` with the branch the write goes to. While the view shows
   * `main`, the edit branch is resolved first: once per visit, shared by
   * concurrent writes. When a resolver chose a branch, the view switches to
   * it after the write. When a resolver throws, `action` does not run and
   * the error is rethrown; the next write asks again.
   */
  write<T>(
    entryId: string | undefined,
    action: (branch: string) => Promise<T>,
  ): Promise<T>;
  /** Tells the gate the branch the view now shows. */
  setShown(branch: string): void;
  /** Drops a resolution that stayed on `main`, so the next write asks again. */
  forget(): void;
}

export function createEditBranchGate(options: {
  readonly branch: string;
  resolve(entryId: string | undefined): Promise<string | undefined>;
  switchTo(branch: string): void;
}): EditBranchGate {
  let shown = options.branch;
  let target = options.branch;
  // Kept after a resolution that stayed on `main`, so later writes of the
  // visit do not ask again.
  let pending: Promise<string> | undefined;
  let isSettledOnMain = false;

  async function targetFor(entryId: string | undefined): Promise<string> {
    if (target !== MAIN_BRANCH) return target;
    const resolution = (pending ??= options.resolve(entryId).then((chosen) => {
      if (chosen === undefined || chosen === MAIN_BRANCH) {
        if (resolution === pending) isSettledOnMain = true;
        return MAIN_BRANCH;
      }
      if (resolution === pending) {
        target = chosen;
        pending = undefined;
      }
      return chosen;
    }));
    try {
      return await resolution;
    } catch (error) {
      if (pending === resolution) pending = undefined;
      throw error;
    }
  }

  return {
    async write(entryId, action) {
      const branch = await targetFor(entryId);
      try {
        return await action(branch);
      } finally {
        if (branch === target && branch !== shown) {
          shown = branch;
          options.switchTo(branch);
        }
      }
    },
    setShown(branch) {
      shown = branch;
      if (branch === target) return;
      target = branch;
      pending = undefined;
      isSettledOnMain = false;
    },
    forget() {
      if (!isSettledOnMain) return;
      pending = undefined;
      isSettledOnMain = false;
    },
  };
}
