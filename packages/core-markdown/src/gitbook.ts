import { encodeAttrs } from "./generic.ts";

/** Type namespace for blocks imported from GitBook tags, such as `gitbook.hint`. */
export const GITBOOK_NAMESPACE = "gitbook";

const TAG = /^[ \t]*\{%-?\s*(end)?([A-Za-z][\w-]*)\s*([\s\S]*?)\s*-?%\}[ \t]*$/;
const FENCE = /^[ \t]{0,3}(`{3,}|~{3,})/;
const ATTRIBUTE = /([A-Za-z][\w-]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|(\S+))/g;

type Node =
  | { readonly kind: "line"; readonly text: string }
  | {
      kind: "tag";
      readonly name: string;
      readonly args: string;
      children: Node[] | undefined;
    };

function parseArgs(args: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  let rest = args;
  for (const match of args.matchAll(ATTRIBUTE)) {
    const [whole, key, double, single, bare] = match;
    if (!key) continue;
    attrs[key] = double ?? single ?? bare ?? "";
    rest = rest.replace(whole, "");
  }
  const leftover = rest.trim();
  if (leftover) attrs.args = leftover;
  return attrs;
}

function quote(value: string): string {
  return `"${value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("\n", "&#xA;")}"`;
}

function attributesOf(name: string, args: string): string {
  const attributes = {
    type: `${GITBOOK_NAMESPACE}.${name}`,
    ...encodeAttrs(parseArgs(args)),
  };
  return Object.entries(attributes)
    .map(([key, value]) => `${key}=${quote(value)}`)
    .join(" ");
}

function parse(lines: readonly string[]): Node[] {
  const root: Node[] = [];
  const stack: { node: Extract<Node, { kind: "tag" }>; parent: Node[] }[] = [];
  let current = root;
  let fence: string | undefined;
  for (const text of lines) {
    const fenceMatch = FENCE.exec(text);
    if (fence) {
      const marker = fenceMatch?.[1];
      if (
        marker !== undefined &&
        marker[0] === fence[0] &&
        marker.length >= fence.length
      ) {
        fence = undefined;
      }
      current.push({ kind: "line", text });
      continue;
    }
    if (fenceMatch?.[1]) {
      fence = fenceMatch[1];
      current.push({ kind: "line", text });
      continue;
    }
    const tag = TAG.exec(text);
    if (!tag) {
      current.push({ kind: "line", text });
      continue;
    }
    const [, end, name = "", args = ""] = tag;
    if (!end) {
      const node: Extract<Node, { kind: "tag" }> = {
        kind: "tag",
        name,
        args,
        children: [],
      };
      current.push(node);
      stack.push({ node, parent: current });
      current = node.children ?? [];
      continue;
    }
    const depth = stack.findLastIndex((entry) => entry.node.name === name);
    if (depth < 0) {
      current.push({ kind: "line", text });
      continue;
    }
    // Tags opened inside the closed one without their own end are self-closing.
    for (const unclosed of stack.splice(depth + 1)) unclose(unclosed);
    const closed = stack.pop();
    current = closed?.parent ?? root;
  }
  for (const unclosed of stack.splice(0).toReversed()) unclose(unclosed);
  return root;

  function unclose(entry: {
    node: Extract<Node, { kind: "tag" }>;
    parent: Node[];
  }): void {
    const children = entry.node.children ?? [];
    entry.node.children = undefined;
    const at = entry.parent.indexOf(entry.node);
    entry.parent.splice(at + 1, 0, ...children);
  }
}

function fenceWidth(nodes: readonly Node[]): number {
  let width = 2;
  for (const node of nodes) {
    if (node.kind === "tag" && node.children) {
      width = Math.max(width, fenceWidth(node.children) + 1);
    }
  }
  return width + 1;
}

function print(nodes: readonly Node[], out: string[]): void {
  for (const node of nodes) {
    if (node.kind === "line") {
      out.push(node.text);
      continue;
    }
    const attributes = attributesOf(node.name, node.args);
    if (!node.children) {
      out.push(`::block{${attributes}}`);
      continue;
    }
    const fence = ":".repeat(fenceWidth(node.children));
    out.push(`${fence}block{${attributes}}`);
    print(node.children, out);
    out.push(fence);
  }
}

/**
 * Rewrites GitBook block tags (`{% hint style="info" %}` ... `{% endhint %}`)
 * into the generic tag syntax, so they import as `gitbook.<name>` blocks.
 * Tags without an end tag become leaf tags. Fenced code is left untouched.
 */
export function convertGitbookTags(markdown: string): string {
  const lines = markdown.split("\n");
  const out: string[] = [];
  print(parse(lines), out);
  return out.join("\n");
}
