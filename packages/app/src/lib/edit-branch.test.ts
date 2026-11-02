import { describe, expect, it, vi } from "vitest";
import { createEditBranchGate } from "./edit-branch.ts";

const noop = () => undefined;

function deferred<T>() {
  let resolve: (value: T) => void = noop;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("createEditBranchGate", () => {
  it("shares one resolution between concurrent writes and switches once", async () => {
    const chosen = deferred<string | undefined>();
    const resolve = vi.fn(() => chosen.promise);
    const switchTo = vi.fn();
    const gate = createEditBranchGate({ branch: "main", resolve, switchTo });

    const first = gate.write("p1", async (branch) => branch);
    const second = gate.write("p2", async (branch) => branch);
    chosen.resolve("cr/1");

    expect(await Promise.all([first, second])).toEqual(["cr/1", "cr/1"]);
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(switchTo).toHaveBeenCalledTimes(1);
    expect(switchTo).toHaveBeenCalledWith("cr/1");

    gate.setShown("cr/1");
    expect(await gate.write("p1", async (branch) => branch)).toBe("cr/1");
    expect(resolve).toHaveBeenCalledTimes(1);
  });

  it("stays on main without asking again when no resolver chooses a branch", async () => {
    const resolve = vi.fn(async () => undefined);
    const switchTo = vi.fn();
    const gate = createEditBranchGate({ branch: "main", resolve, switchTo });

    expect(await gate.write("p1", async (branch) => branch)).toBe("main");
    expect(await gate.write("p1", async (branch) => branch)).toBe("main");
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(switchTo).not.toHaveBeenCalled();

    gate.forget();
    await gate.write("p1", async (branch) => branch);
    expect(resolve).toHaveBeenCalledTimes(2);
  });

  it("does not write when a resolver throws, and asks again next time", async () => {
    const resolve = vi
      .fn<() => Promise<string | undefined>>()
      .mockRejectedValueOnce(new Error("failed"))
      .mockResolvedValueOnce("cr/2");
    const switchTo = vi.fn();
    const action = vi.fn(async (branch: string) => branch);
    const gate = createEditBranchGate({ branch: "main", resolve, switchTo });

    await expect(gate.write("p1", action)).rejects.toThrow("failed");
    expect(action).not.toHaveBeenCalled();
    expect(await gate.write("p1", action)).toBe("cr/2");
    expect(switchTo).toHaveBeenCalledWith("cr/2");
  });

  it("writes to the shown branch without asking", async () => {
    const resolve = vi.fn(async () => "cr/9");
    const switchTo = vi.fn();
    const gate = createEditBranchGate({ branch: "cr/1", resolve, switchTo });
    expect(await gate.write(undefined, async (branch) => branch)).toBe("cr/1");
    expect(resolve).not.toHaveBeenCalled();

    gate.setShown("main");
    expect(await gate.write(undefined, async (branch) => branch)).toBe("cr/9");
    expect(resolve).toHaveBeenCalledTimes(1);
  });

  it("switches even when the write on the new branch fails", async () => {
    const switchTo = vi.fn();
    const gate = createEditBranchGate({
      branch: "main",
      resolve: async () => "cr/1",
      switchTo,
    });
    await expect(
      gate.write("p1", async () => {
        throw new Error("rejected");
      }),
    ).rejects.toThrow("rejected");
    expect(switchTo).toHaveBeenCalledWith("cr/1");
  });
});
