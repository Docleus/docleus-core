import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDom, type TestDom } from "../test-dom.tsx";
import { InstancePlugins } from "./instance-plugins.tsx";

const BUNDLED = {
  name: "@docleus/plugin-editor",
  version: "0.0.1",
  hasEditor: true,
  isInstalled: false,
};
const STAMP = {
  name: "@acme/stamp",
  version: "1.0.0",
  hasEditor: true,
  isInstalled: true,
  source: { type: "tarball", filename: "stamp-1.0.0.tgz" },
};

let dom: TestDom;

beforeEach(() => {
  dom = createTestDom();
});

afterEach(async () => {
  vi.unstubAllGlobals();
  await dom.dispose();
});

// The install forms sit in a dialog, which renders into document.body.
function form(name: string): HTMLFormElement {
  const found = document.querySelector<HTMLFormElement>(
    `form[aria-label="${name}"]`,
  );
  if (!found) throw new Error(`no form ${name}`);
  return found;
}

async function openInstall(source: "Upload" | "Server path" | "Git") {
  if (!document.querySelector('[role="dialog"]')) {
    const open = await dom.waitFor(() => dom.button("Install a plugin…"));
    await dom.click(open);
  }
  const tab = await dom.waitFor(() => dom.button(source));
  await dom.click(tab);
}

function field(label: string): HTMLInputElement {
  return dom.field(label, document.body) as HTMLInputElement;
}

describe("InstancePlugins", () => {
  it("uploads a tarball and lists the installed plugin", async () => {
    let plugins: unknown[] = [BUNDLED];
    dom.route("GET", "/api/plugins", () => ({ body: { plugins } }));
    dom.route("POST", "/api/plugins/upload?filename=stamp-1.0.0.tgz", () => {
      plugins = [BUNDLED, STAMP];
      return { status: 201, body: { plugin: STAMP } };
    });
    await dom.render(<InstancePlugins />);
    await dom.waitFor(() => dom.text().includes("Bundled"));
    expect(dom.button("Uninstall @docleus/plugin-editor")).toBeUndefined();

    await openInstall("Upload");
    const input = field("Tarball (.tgz)");
    const file = new File([new Uint8Array([1, 2, 3])], "stamp-1.0.0.tgz", {
      type: "application/gzip",
    });
    await act(async () => {
      Object.defineProperty(input, "files", { value: [file] });
      input.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await dom.submit(form("Upload plugin"));

    await dom.waitFor(() => dom.text().includes("Installed @acme/stamp 1.0.0"));
    const upload = dom.calls.find((call) => call.method === "POST");
    expect(upload?.path).toBe("/api/plugins/upload?filename=stamp-1.0.0.tgz");
    const init = vi
      .mocked(fetch)
      .mock.calls.find(([path]) => path === upload?.path)?.[1];
    expect(init?.body).toBe(file);
    expect(new Headers(init?.headers).get("content-type")).toBe(
      "application/gzip",
    );
    await dom.waitFor(() => dom.text().includes("Upload stamp-1.0.0.tgz"));
    expect(dom.button("Uninstall @acme/stamp")).toBeDefined();
  });

  it("installs from a path and from Git", async () => {
    dom.route("GET", "/api/plugins", () => ({ body: { plugins: [] } }));
    dom.route("POST", "/api/plugins", (call) => ({
      status: 201,
      body: { plugin: { ...STAMP, source: call.body } },
    }));
    await dom.render(<InstancePlugins />);
    await openInstall("Server path");
    await dom.type(field("Server path"), "/srv/plugins/stamp");
    await dom.submit(form("Install from a path"));
    await dom.waitFor(() => dom.text().includes("Installed @acme/stamp"));

    await openInstall("Git");
    await dom.type(field("Git URL"), "https://example.com/stamp.git");
    await dom.type(field("Ref"), "v1.0.0");
    await dom.submit(form("Install from Git"));
    await dom.waitFor(
      () => dom.calls.filter((call) => call.method === "POST").length === 2,
    );
    expect(
      dom.calls.filter((call) => call.method === "POST").map((c) => c.body),
    ).toEqual([
      { type: "path", path: "/srv/plugins/stamp" },
      { type: "git", url: "https://example.com/stamp.git", ref: "v1.0.0" },
    ]);
  });

  it("shows why an install was refused", async () => {
    dom.route("GET", "/api/plugins", () => ({ body: { plugins: [] } }));
    dom.route("POST", "/api/plugins", () => ({
      status: 409,
      body: {
        code: "plugin/engines-mismatch",
        message: "@acme/stamp requires docleus ^9, running 0.0.1",
      },
    }));
    await dom.render(<InstancePlugins />);
    await openInstall("Server path");
    await dom.type(field("Server path"), "/srv/x");
    await dom.submit(form("Install from a path"));
    const alert = await dom.waitFor(() =>
      document.querySelector('[role="dialog"] [role="alert"]'),
    );
    expect(alert.textContent).toBe(
      "@acme/stamp requires docleus ^9, running 0.0.1 (plugin/engines-mismatch)",
    );
  });

  it("uninstalls after confirmation", async () => {
    let plugins: unknown[] = [STAMP];
    dom.route("GET", "/api/plugins", () => ({ body: { plugins } }));
    dom.route("DELETE", "/api/plugins/%40acme%2Fstamp", () => {
      plugins = [];
      return { status: 204 };
    });
    vi.stubGlobal(
      "confirm",
      vi.fn(() => true),
    );
    await dom.render(<InstancePlugins />);
    const button = await dom.waitFor(() => dom.button("Uninstall @acme/stamp"));
    await dom.click(button);
    await dom.waitFor(() => dom.text().includes("Uninstalled @acme/stamp."));
    await dom.waitFor(() => !dom.button("Uninstall @acme/stamp"));
  });
});
