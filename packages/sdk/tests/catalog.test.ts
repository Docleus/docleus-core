import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import {
  EVENTS,
  EXTENSION_POINTS,
  defineEvent,
  defineService,
  renderCatalog,
} from "../src/index.ts";

const catalogPath = fileURLToPath(
  new URL("../extension-catalog.md", import.meta.url),
);
const indexPath = fileURLToPath(new URL("../src/index.ts", import.meta.url));
const contextPath = fileURLToPath(
  new URL("../src/context.ts", import.meta.url),
);

function loadProgram(): { program: ts.Program; checker: ts.TypeChecker } {
  const program = ts.createProgram([indexPath], {
    target: ts.ScriptTarget.ESNext,
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    allowImportingTsExtensions: true,
    noEmit: true,
  });
  return { program, checker: program.getTypeChecker() };
}

/** The node a TSDoc comment for `declaration` is attached to. */
function documentedNode(declaration: ts.Node): ts.Node {
  if (ts.isExportSpecifier(declaration)) return declaration.parent.parent;
  if (ts.isNamespaceExport(declaration)) return declaration.parent;
  if (ts.isVariableDeclaration(declaration)) {
    return declaration.parent.parent;
  }
  return declaration;
}

const hasDoc = (declaration: ts.Node): boolean =>
  ts.getJSDocCommentsAndTags(documentedNode(declaration)).length > 0;

function tagsOf(node: ts.Node): Map<string, string> {
  return new Map(
    ts
      .getJSDocTags(node)
      .map((tag) => [
        tag.tagName.text,
        (ts.getTextOfJSDocComment(tag.comment) ?? "").trim(),
      ]),
  );
}

describe("extension catalog", () => {
  it("matches the declarations in the SDK (run with UPDATE_CATALOG=1 to regenerate)", () => {
    const rendered = renderCatalog(EXTENSION_POINTS);
    if (process.env["UPDATE_CATALOG"] === "1")
      writeFileSync(catalogPath, rendered);
    expect(existsSync(catalogPath)).toBe(true);
    expect(readFileSync(catalogPath, "utf8")).toBe(rendered);
  });

  // Before 1.0 nothing is stable (architecture.md, section 7).
  it("marks every extension point experimental", () => {
    const stable = EXTENSION_POINTS.filter(
      (point) => point.stability !== "experimental",
    ).map((point) => point.name);
    expect(stable).toEqual([]);
  });

  it("lists events and services sorted by name with their mode and stability", () => {
    const rendered = renderCatalog([
      defineEvent({
        name: "b/two",
        mode: "bail",
        stability: "stable",
        description: "Second.",
      }),
      defineEvent({
        name: "a/one",
        mode: "emit",
        stability: "experimental",
        description: "First.",
      }),
      defineService({
        name: "svc",
        stability: "experimental",
        description: "A service.",
      }),
    ]);
    expect(rendered.indexOf("a/one")).toBeLessThan(rendered.indexOf("b/two"));
    expect(rendered).toContain("| `a/one` | emit | experimental | First. |");
    expect(rendered).toContain("| `svc` | experimental | A service. |");
  });
});

describe("TSDoc", () => {
  const { program, checker } = loadProgram();

  it("documents every public export of the SDK", () => {
    const index = program.getSourceFile(indexPath);
    const module = index && checker.getSymbolAtLocation(index);
    if (!module) throw new Error("cannot load src/index.ts");
    const undocumented = checker
      .getExportsOfModule(module)
      .filter((symbol) => {
        if ((symbol.declarations ?? []).some(hasDoc)) return false;
        const target =
          symbol.flags & ts.SymbolFlags.Alias
            ? checker.getAliasedSymbol(symbol)
            : symbol;
        return !(target.declarations ?? []).some(hasDoc);
      })
      .map((symbol) => symbol.name)
      .toSorted();
    expect(undocumented).toEqual([]);
  });

  it("gives every event a TSDoc with @mode and @stability matching its declaration", () => {
    const context = program.getSourceFile(contextPath);
    if (!context) throw new Error("cannot load src/context.ts");
    const declared = new Map<string, Map<string, string>>();
    const visit = (node: ts.Node): void => {
      if (ts.isInterfaceDeclaration(node) && node.name.text === "Events") {
        for (const member of node.members) {
          if (member.name && ts.isStringLiteral(member.name)) {
            declared.set(member.name.text, tagsOf(member));
          }
        }
        return;
      }
      ts.forEachChild(node, visit);
    };
    visit(context);

    const problems: string[] = [];
    for (const [name, tags] of declared) {
      if (!tags.has("mode")) problems.push(`${name}: no @mode`);
      if (!tags.has("stability")) problems.push(`${name}: no @stability`);
    }
    for (const event of Object.values(EVENTS)) {
      const tags = declared.get(event.name);
      if (!tags) {
        problems.push(`${event.name}: not in Events`);
        continue;
      }
      if (tags.get("mode") !== event.mode) {
        problems.push(`${event.name}: @mode is not ${event.mode}`);
      }
      if (tags.get("stability") !== event.stability) {
        problems.push(`${event.name}: @stability is not ${event.stability}`);
      }
    }
    for (const name of declared.keys()) {
      if (!Object.values(EVENTS).some((event) => event.name === name)) {
        problems.push(`${name}: not declared in EVENTS`);
      }
    }
    expect(problems).toEqual([]);
  });
});
