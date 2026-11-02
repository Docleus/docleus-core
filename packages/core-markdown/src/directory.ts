import {
  DocleusError,
  type DirectoryEntry,
  type DirectoryImport,
  type MarkdownDocument,
  type SpaceFiles,
} from "@docleus/sdk";
import type { List, ListItem, Root } from "mdast";
import { fromMarkdown } from "mdast-util-from-markdown";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { YAML_PRINT_OPTIONS } from "./frontmatter.ts";

export const SUMMARY_FILE = "SUMMARY.md";
export const CONFIG_FILE = ".docleus.yaml";
const GITBOOK_CONFIG_FILE = ".gitbook.yaml";
const README = /(^|\/)(README|index)\.md$/i;

export interface DocumentCodec {
  parse(markdown: string, options: { gitbook: boolean }): MarkdownDocument;
  serialize(document: MarkdownDocument): string;
}

interface Node {
  readonly path: string;
  readonly title: string | undefined;
  readonly children: Node[];
}

function isMarkdown(path: string): boolean {
  return path.toLowerCase().endsWith(".md");
}

function dirOf(path: string): string {
  const at = path.lastIndexOf("/");
  return at < 0 ? "" : path.slice(0, at);
}

function baseName(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

function joinPath(dir: string, path: string): string {
  const parts = dir ? dir.split("/") : [];
  for (const part of path.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") parts.pop();
    else parts.push(part);
  }
  return parts.join("/");
}

function textOf(node: { children?: unknown[]; value?: unknown }): string {
  if (typeof node.value === "string") return node.value;
  return (node.children ?? [])
    .map((child) => textOf(child as { children?: unknown[]; value?: unknown }))
    .join("");
}

/** The entry tree a `SUMMARY.md` describes: nested list items that link to files. */
export function parseSummary(markdown: string, baseDir = ""): Node[] {
  const tree: Root = fromMarkdown(markdown);
  const fromList = (list: List): Node[] =>
    list.children.flatMap((item: ListItem) => {
      const paragraph = item.children.find(
        (child) => child.type === "paragraph",
      );
      const link = paragraph?.children.find((child) => child.type === "link");
      const nested = item.children.filter(
        (child): child is List => child.type === "list",
      );
      const children = nested.flatMap(fromList);
      if (!link || /^[a-z]+:/i.test(link.url)) return children;
      const path = joinPath(baseDir, decodeURI(link.url.split("#")[0] ?? ""));
      return [{ path, title: textOf(link) || undefined, children }];
    });
  return tree.children.flatMap((node) =>
    node.type === "list" ? fromList(node) : [],
  );
}

/** The tree structure only: titles may come from frontmatter, so they are not compared. */
function summaryShape(nodes: readonly Node[]): unknown {
  return nodes.map((node) => [node.path, summaryShape(node.children)]);
}

function printSummary(nodes: readonly Node[]): string {
  const lines = ["# Summary", ""];
  const walk = (level: readonly Node[], depth: number): void => {
    for (const node of level) {
      const title = (node.title ?? node.path).replaceAll(/([[\]\\])/g, "\\$1");
      lines.push(`${"  ".repeat(depth)}* [${title}](${encodeURI(node.path)})`);
      walk(node.children, depth + 1);
    }
  };
  walk(nodes, 0);
  return `${lines.join("\n")}\n`;
}

function titleFromFile(path: string): string {
  const name = baseName(README.test(path) ? dirOf(path) || path : path).replace(
    /\.md$/i,
    "",
  );
  return name.replaceAll(/[-_]+/g, " ") || path;
}

function firstHeading(markdown: string): string | undefined {
  return /^#{1,6}[ \t]+(.+?)[ \t#]*$/m.exec(markdown)?.[1];
}

function orderOf(document: MarkdownDocument): number | undefined {
  const order = document.frontmatter?.order;
  return typeof order === "number" && Number.isFinite(order)
    ? order
    : undefined;
}

/** Without `SUMMARY.md`: a directory's README is its page, and it parents the directory's other files. */
function deriveTree(
  paths: readonly string[],
  documents: ReadonlyMap<string, MarkdownDocument>,
): Node[] {
  const readmeOf = new Map<string, string>();
  for (const path of paths)
    if (README.test(path)) readmeOf.set(dirOf(path), path);
  // The root README is the first top-level page, as in GitBook, not the
  // parent of every other page.
  const parentOf = (path: string): string | undefined => {
    // A README is its directory's page, so its parent lives one level up.
    let dir = README.test(path) ? dirOf(dirOf(path)) : dirOf(path);
    while (dir !== "") {
      const readme = readmeOf.get(dir);
      if (readme !== undefined && readme !== path) return readme;
      dir = dirOf(dir);
    }
    return undefined;
  };
  const children = new Map<string | undefined, string[]>();
  for (const path of paths) {
    const parent = parentOf(path);
    children.set(parent, [...(children.get(parent) ?? []), path]);
  }
  const sorted = (list: readonly string[]): string[] =>
    [...list].toSorted((a, b) => {
      const oa = orderOf(documents.get(a) ?? { body: emptyDoc() }) ?? Infinity;
      const ob = orderOf(documents.get(b) ?? { body: emptyDoc() }) ?? Infinity;
      if (oa !== ob) return oa - ob;
      // Only the root README is a sibling of other pages; a subdirectory's
      // README stands for the directory and sorts by its name.
      const rootReadme = readmeOf.get("");
      if ((a === rootReadme) !== (b === rootReadme))
        return a === rootReadme ? -1 : 1;
      return a < b ? -1 : a > b ? 1 : 0;
    });
  const build = (parent: string | undefined): Node[] =>
    sorted(children.get(parent) ?? []).map((path) => ({
      path,
      title: undefined,
      children: build(path),
    }));
  return build(undefined);
}

function emptyDoc(): MarkdownDocument["body"] {
  return { id: "", type: "doc", v: 1, attrs: {}, content: [] };
}

export function importDirectory(
  files: SpaceFiles,
  codec: DocumentCodec,
): DirectoryImport {
  const warnings: string[] = [];
  const gitbook = GITBOOK_CONFIG_FILE in files;
  let config: Record<string, unknown> = {};
  const configText = files[CONFIG_FILE];
  if (configText !== undefined) {
    let parsed: unknown;
    try {
      parsed = parseYaml(configText);
    } catch (error) {
      throw new DocleusError(
        "markdown/invalid-space-config",
        `${CONFIG_FILE} is not valid YAML`,
        {
          cause: error,
        },
      );
    }
    if (parsed !== null && parsed !== undefined) {
      if (typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new DocleusError(
          "markdown/invalid-space-config",
          `${CONFIG_FILE} must be a YAML mapping`,
        );
      }
      config = parsed as Record<string, unknown>;
    }
  }

  const paths = Object.keys(files)
    .filter((path) => isMarkdown(path) && baseName(path) !== SUMMARY_FILE)
    .toSorted();
  const documents = new Map<string, MarkdownDocument>();
  for (const path of paths) {
    const text = files[path] ?? "";
    documents.set(
      path,
      codec.parse(text, { gitbook: gitbook || text.includes("{%") }),
    );
  }

  const summary = files[SUMMARY_FILE];
  let tree: Node[];
  if (summary === undefined) {
    tree = deriveTree(paths, documents);
  } else {
    tree = parseSummary(summary);
    const listed = new Set<string>();
    const keep = (nodes: Node[]): Node[] =>
      nodes.flatMap((node) => {
        const children = keep(node.children);
        if (!documents.has(node.path)) {
          warnings.push(
            `${SUMMARY_FILE} links to "${node.path}", which does not exist`,
          );
          return children;
        }
        if (listed.has(node.path)) {
          warnings.push(`${SUMMARY_FILE} lists "${node.path}" more than once`);
          return children;
        }
        listed.add(node.path);
        return [{ ...node, children }];
      });
    tree = keep(tree);
    for (const path of paths) {
      if (!listed.has(path))
        warnings.push(`"${path}" is not listed in ${SUMMARY_FILE}`);
    }
  }

  const entries: DirectoryEntry[] = [];
  const walk = (nodes: readonly Node[], parent: string | undefined): void => {
    nodes.forEach((node, order) => {
      const document = documents.get(node.path);
      if (!document) return;
      const fromFrontmatter = document.frontmatter?.title;
      const title =
        node.title ??
        (typeof fromFrontmatter === "string" ? fromFrontmatter : undefined) ??
        firstHeading(files[node.path] ?? "") ??
        titleFromFile(node.path);
      entries.push({ path: node.path, title, parent, order, document });
      walk(node.children, node.path);
    });
  };
  walk(tree, undefined);
  return { entries, config, configText, summary, warnings };
}

export function exportDirectory(
  input: Pick<DirectoryImport, "entries" | "config" | "configText" | "summary">,
  codec: DocumentCodec,
): Record<string, string> {
  const files: Record<string, string> = {};
  for (const entry of input.entries) {
    files[entry.path] = codec.serialize(entry.document);
  }

  const byParent = new Map<string | undefined, DirectoryEntry[]>();
  for (const entry of input.entries) {
    byParent.set(entry.parent, [...(byParent.get(entry.parent) ?? []), entry]);
  }
  const build = (parent: string | undefined): Node[] =>
    [...(byParent.get(parent) ?? [])]
      .toSorted((a, b) => a.order - b.order)
      .map((entry) => ({
        path: entry.path,
        title: entry.title,
        children: build(entry.path),
      }));
  const tree = build(undefined);

  const kept = input.summary;
  const isUnchanged =
    kept !== undefined &&
    JSON.stringify(summaryShape(parseSummary(kept))) ===
      JSON.stringify(summaryShape(tree));
  files[SUMMARY_FILE] = isUnchanged ? kept : printSummary(tree);

  const keptConfig = input.configText;
  if (keptConfig !== undefined && isSameConfig(keptConfig, input.config)) {
    files[CONFIG_FILE] = keptConfig;
  } else if (Object.keys(input.config).length > 0) {
    files[CONFIG_FILE] = stringifyYaml(input.config, YAML_PRINT_OPTIONS);
  }
  return files;
}

function isSameConfig(
  text: string,
  config: Readonly<Record<string, unknown>>,
): boolean {
  try {
    return JSON.stringify(parseYaml(text) ?? {}) === JSON.stringify(config);
  } catch {
    // An unparsable kept file cannot be equal; it is replaced below.
    return false;
  }
}
