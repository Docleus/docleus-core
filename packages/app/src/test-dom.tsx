import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { vi } from "vitest";

export interface Call {
  readonly method: string;
  readonly path: string;
  readonly body: unknown;
  readonly credentials: RequestCredentials | undefined;
}

export type Handler = (call: Call) => { status?: number; body?: unknown };

/**
 * A DOM container plus a `fetch` stub that answers from registered routes
 * (unknown routes answer 404). Create one in `beforeEach`, dispose it in
 * `afterEach`.
 */
export interface TestDom {
  readonly calls: Call[];
  readonly container: HTMLElement;
  route(method: string, path: string, handler: Handler): void;
  render(node: ReactNode): Promise<void>;
  waitFor<T>(find: () => T | null | undefined | false): Promise<T>;
  button(name: string): HTMLButtonElement | undefined;
  field(
    label: string,
    within?: ParentNode,
  ): HTMLInputElement | HTMLSelectElement | undefined;
  type(
    element: HTMLInputElement | HTMLSelectElement,
    value: string,
  ): Promise<void>;
  click(element: HTMLElement): Promise<void>;
  submit(form: HTMLFormElement): Promise<void>;
  text(): string;
  dispose(): Promise<void>;
}

export function createTestDom(): TestDom {
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  const calls: Call[] = [];
  const routes = new Map<string, Handler>();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (path: string, init: RequestInit = {}) => {
      const method = init.method ?? "GET";
      const body =
        typeof init.body === "string"
          ? (JSON.parse(init.body) as unknown)
          : undefined;
      const call = { method, path, body, credentials: init.credentials };
      calls.push(call);
      const handler = routes.get(`${method} ${path}`);
      const result = handler
        ? handler(call)
        : { status: 404, body: { code: "test/no-route", message: path } };
      return new Response(JSON.stringify(result.body ?? {}), {
        status: result.status ?? 200,
        headers: { "content-type": "application/json" },
      });
    }),
  );
  const container = document.createElement("div");
  document.body.append(container);
  const root: Root = createRoot(container);

  const dom: TestDom = {
    calls,
    container,
    route(method, path, handler) {
      routes.set(`${method} ${path}`, handler);
    },
    async render(node) {
      await act(async () => {
        root.render(node);
      });
    },
    async waitFor(find) {
      for (let attempt = 0; attempt < 50; attempt++) {
        const found = find();
        if (found !== null && found !== undefined && found !== false) {
          return found;
        }
        await act(async () => {
          await new Promise((resolve) => setTimeout(resolve, 0));
        });
      }
      throw new Error(`not found; page was: ${container.textContent}`);
    },
    // Menus and dialogs render into document.body, outside the container.
    button(name) {
      return [...document.querySelectorAll("button")].find(
        (candidate) =>
          candidate.getAttribute("aria-label") === name ||
          candidate.textContent === name,
      );
    },
    field(label, within = container) {
      const byLabel = [...within.querySelectorAll("label")].find((candidate) =>
        candidate.textContent?.startsWith(label),
      );
      const found =
        byLabel?.querySelector("input, select") ??
        within.querySelector(`[aria-label="${label}"]`);
      return found instanceof HTMLInputElement ||
        found instanceof HTMLSelectElement
        ? found
        : undefined;
    },
    async type(element, value) {
      const prototype =
        element instanceof HTMLSelectElement
          ? HTMLSelectElement.prototype
          : HTMLInputElement.prototype;
      await act(async () => {
        Object.getOwnPropertyDescriptor(prototype, "value")?.set?.call(
          element,
          value,
        );
        element.dispatchEvent(
          new Event(element instanceof HTMLSelectElement ? "change" : "input", {
            bubbles: true,
          }),
        );
      });
    },
    async click(element) {
      await act(async () => {
        element.click();
      });
    },
    async submit(form) {
      await act(async () => {
        form.requestSubmit();
      });
    },
    text() {
      return container.textContent ?? "";
    },
    async dispose() {
      await act(async () => root.unmount());
      container.remove();
    },
  };
  return dom;
}

/** Puts the browser at `path` (with its query) before a render. */
export function visit(path: string): void {
  history.replaceState(null, "", path);
}

export function currentPath(): string {
  return location.pathname + location.search;
}
