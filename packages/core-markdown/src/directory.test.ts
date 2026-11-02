import { Context, type DirectoryImport } from "@docleus/sdk";
import { describe, expect, it } from "vitest";
import { CONFIG_FILE, SUMMARY_FILE, createMarkdownService } from "./index.ts";

const markdown = createMarkdownService(new Context());

const shape = (result: DirectoryImport): unknown =>
  result.entries.map(({ path, title, parent, order }) => ({
    path,
    title,
    parent,
    order,
  }));

describe("importDirectory with SUMMARY.md", () => {
  const files = {
    [SUMMARY_FILE]:
      "# Summary\n\n* [Home](README.md)\n* [Guide](guide/README.md)\n  * [Install](guide/install.md)\n  * [Gone](guide/gone.md)\n* [Elsewhere](https://example.com)\n",
    "README.md": "# Welcome\n",
    "guide/README.md": "Guide.\n",
    "guide/install.md": "Install.\n",
    "stray.md": "Not listed.\n",
  };

  it("builds the tree the summary describes, titled by the link text", () => {
    expect(shape(markdown.importDirectory(files))).toEqual([
      { path: "README.md", title: "Home", parent: undefined, order: 0 },
      { path: "guide/README.md", title: "Guide", parent: undefined, order: 1 },
      {
        path: "guide/install.md",
        title: "Install",
        parent: "guide/README.md",
        order: 0,
      },
    ]);
  });

  it("warns about missing and unlisted files, ignoring external links", () => {
    expect(markdown.importDirectory(files).warnings).toEqual([
      `${SUMMARY_FILE} links to "guide/gone.md", which does not exist`,
      `"stray.md" is not listed in ${SUMMARY_FILE}`,
    ]);
  });

  it("warns about a file listed twice and keeps its first place", () => {
    const result = markdown.importDirectory({
      [SUMMARY_FILE]: "* [A](a.md)\n* [B](b.md)\n* [A again](a.md)\n",
      "a.md": "",
      "b.md": "",
    });
    expect(result.entries.map((entry) => entry.path)).toEqual(["a.md", "b.md"]);
    expect(result.warnings).toEqual([
      `${SUMMARY_FILE} lists "a.md" more than once`,
    ]);
  });
});

describe("importDirectory without SUMMARY.md", () => {
  it("nests files under their subdirectory's README and orders by frontmatter, then README, then name", () => {
    const result = markdown.importDirectory({
      "README.md": "Home.\n",
      "zeta.md": "---\norder: 1\n---\n# Zeta page\n",
      "alpha.md": "---\ntitle: Alpha\n---\n",
      "docs/README.md": "",
      "docs/b-two.md": "",
      "docs/a_one.md": "",
      "docs/deep/file.md": "",
    });
    expect(shape(result)).toEqual([
      { path: "zeta.md", title: "Zeta page", parent: undefined, order: 0 },
      { path: "README.md", title: "README", parent: undefined, order: 1 },
      { path: "alpha.md", title: "Alpha", parent: undefined, order: 2 },
      { path: "docs/README.md", title: "docs", parent: undefined, order: 3 },
      {
        path: "docs/a_one.md",
        title: "a one",
        parent: "docs/README.md",
        order: 0,
      },
      {
        path: "docs/b-two.md",
        title: "b two",
        parent: "docs/README.md",
        order: 1,
      },
      {
        path: "docs/deep/file.md",
        title: "file",
        parent: "docs/README.md",
        order: 2,
      },
    ]);
    expect(result.warnings).toEqual([]);
  });
});

describe("space config", () => {
  it("parses .docleus.yaml and rejects one that is not a mapping", () => {
    expect(
      markdown.importDirectory({ [CONFIG_FILE]: "theme: dark\n" }).config,
    ).toEqual({
      theme: "dark",
    });
    expect(() => markdown.importDirectory({ [CONFIG_FILE]: "- a\n" })).toThrow(
      expect.objectContaining({ code: "markdown/invalid-space-config" }),
    );
    expect(() => markdown.importDirectory({ [CONFIG_FILE]: "a: [\n" })).toThrow(
      expect.objectContaining({ code: "markdown/invalid-space-config" }),
    );
  });
});

describe("exportDirectory", () => {
  const files = {
    [SUMMARY_FILE]:
      "# Table of contents\n\n- [Start](start.md)\n    - [Child](child.md)\n",
    [CONFIG_FILE]: "# comment\ntheme:   dark\n",
    "start.md": "---\ntitle:  S\n---\nStart   text.\n",
    "child.md": "Child.",
  };

  it("exports an unchanged import byte for byte", () => {
    expect(markdown.exportDirectory(markdown.importDirectory(files))).toEqual(
      files,
    );
  });

  it("rewrites SUMMARY.md only when the tree changes, and the config only when it changes", () => {
    const imported = markdown.importDirectory(files);
    const flattened = {
      ...imported,
      entries: imported.entries.map((entry) => ({
        ...entry,
        parent: undefined,
      })),
      config: { theme: "light" },
    };
    const exported = markdown.exportDirectory(flattened);
    expect(exported[SUMMARY_FILE]).toBe(
      "# Summary\n\n* [Start](start.md)\n* [Child](child.md)\n",
    );
    expect(exported[CONFIG_FILE]).toBe("theme: light\n");
    expect(exported["start.md"]).toBe(files["start.md"]);
  });

  it("writes a SUMMARY.md for a directory that had none, and no config when empty", () => {
    const exported = markdown.exportDirectory(
      markdown.importDirectory({ "README.md": "", "a [b].md": "" }),
    );
    expect(exported[SUMMARY_FILE]).toBe(
      "# Summary\n\n* [README](README.md)\n* [a \\[b\\]](a%20%5Bb%5D.md)\n",
    );
    expect(exported).not.toHaveProperty(CONFIG_FILE);
    expect(
      Object.keys(markdown.importDirectory(exported).entries),
    ).toHaveLength(2);
  });
});

describe("GitBook spaces", () => {
  it("converts GitBook tags when .gitbook.yaml is present or a file uses them", () => {
    const result = markdown.importDirectory({
      ".gitbook.yaml": "root: ./\n",
      "README.md": '{% hint style="info" %}\nNote.\n{% endhint %}\n',
    });
    const [block] = result.entries[0]?.document.body.content ?? [];
    expect(block?.type).toBe("gitbook.hint");
    expect(block?.attrs).toEqual({ style: "info" });
  });
});
