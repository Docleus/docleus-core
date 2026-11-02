import { createCalloutCodec } from "@docleus/conformance";
import { Context, type BlockNode, type MarkdownCodec } from "@docleus/sdk";
import type { PhrasingContent } from "mdast";
import { describe, expect, it } from "vitest";
import { createMarkdownService, provideMarkdown } from "./index.ts";

const conflict = expect.objectContaining({ code: "markdown/syntax-conflict" });

/** Reads `:mention{user=...}` text directives as `acme.mention` inline nodes. */
const mentionCodec: MarkdownCodec = {
  name: "acme.mentions",
  claims: ["directive:mention"],
  inlineTypes: ["acme.mention"],
  toInline(node) {
    if (node.type !== "textDirective" || node.name !== "mention")
      return undefined;
    return {
      type: "acme.mention",
      attrs: { user: node.attributes?.user ?? "" },
    };
  },
  fromInline(node): PhrasingContent {
    return {
      type: "textDirective",
      name: "mention",
      attributes: { user: String(node.attrs?.user) },
      children: [],
    };
  },
};

function codeBlock(name: string, claim: string, type: string): MarkdownCodec {
  return {
    name,
    claims: [claim],
    blockTypes: [type],
    toBlock(node, context) {
      if (node.type !== "code") return undefined;
      if (claim === "code:diagram" && node.lang !== "diagram") return undefined;
      return { id: context.newId(), type, v: 1, attrs: {} };
    },
  };
}

describe("codec registration", () => {
  it("rejects core syntax, core types, duplicate names and taken claims", () => {
    const markdown = createMarkdownService(new Context());
    const base = { name: "acme.a", claims: [] };
    expect(() => markdown.register({ ...base, claims: ["paragraph"] })).toThrow(
      conflict,
    );
    expect(() =>
      markdown.register({ ...base, claims: ["directive:block"] }),
    ).toThrow(conflict);
    expect(() => markdown.register({ ...base, blockTypes: ["raw"] })).toThrow(
      conflict,
    );
    expect(() => markdown.register({ ...base, inlineTypes: ["text"] })).toThrow(
      conflict,
    );
    markdown.register({
      ...base,
      claims: ["heading"],
      blockTypes: ["acme.heading"],
    });
    expect(() => markdown.register(base)).toThrow(conflict);
    expect(() =>
      markdown.register({ name: "acme.b", claims: ["heading"] }),
    ).toThrow(conflict);
    expect(() =>
      markdown.register({
        name: "acme.c",
        claims: [],
        blockTypes: ["acme.heading"],
      }),
    ).toThrow(conflict);
  });

  it("unregisters a plugin's codec when the plugin unloads", async () => {
    const root = new Context();
    const core = await root.plugin((ctx: Context) => {
      provideMarkdown(ctx);
    });
    const plugin = await root.plugin({
      inject: ["markdown"],
      apply: (ctx: Context) => {
        ctx.markdown.register(createCalloutCodec());
      },
    });
    const source = ':::callout{tone="warn"}\nA\n:::\n';
    expect(root.markdown.parse(source).body.content?.[0]?.type).toBe(
      "test.callout",
    );
    await plugin.dispose();
    expect(root.markdown.parse(source).body.content?.[0]?.type).toBe("raw");
    expect(() => root.markdown.register(createCalloutCodec())).not.toThrow();
    await core.dispose();
  });

  it("asks a codec with a narrower claim before the one with the broad claim", () => {
    const markdown = createMarkdownService(new Context());
    markdown.register(codeBlock("acme.code", "code", "acme.code"));
    markdown.register(
      codeBlock("acme.diagram", "code:diagram", "acme.diagram"),
    );
    const types = markdown
      .parse("```diagram\nA\n```\n\n```js\nB\n```\n")
      .body.content?.map((block) => block.type);
    expect(types).toEqual(["acme.diagram", "acme.code"]);
  });

  it("lets an inline codec claim and print inline nodes", () => {
    const markdown = createMarkdownService(new Context());
    markdown.register(mentionCodec);
    const document = markdown.parse('Hi :mention{user="ada"} and `code`.\n');
    const inline = document.body.content?.[0]?.inline;
    expect(inline?.[1]).toEqual({
      type: "acme.mention",
      attrs: { user: "ada" },
    });
    expect(inline?.[3]).toEqual({
      type: "text",
      text: "code",
      marks: [{ type: "code" }],
    });
    expect(markdown.serialize({ ...document, source: undefined })).toBe(
      'Hi :mention{user="ada"} and `code`.\n',
    );
  });

  it("keeps the marks around claimed, raw and generic inline nodes", () => {
    const markdown = createMarkdownService(new Context());
    markdown.register(mentionCodec);
    const source =
      '**a :mention{user="ada"}** [*<b>x</b>*](/l) ~~:inline{type="acme.chip"}~~\n';
    const document = markdown.parse(source);
    const inline = document.body.content?.[0]?.inline;
    expect(inline?.[1]).toEqual({
      type: "acme.mention",
      attrs: { user: "ada" },
      marks: [{ type: "bold" }],
    });
    expect(inline?.[3]).toEqual({
      type: "raw",
      attrs: { source: "<b>" },
      marks: [{ type: "link", attrs: { href: "/l" } }, { type: "italic" }],
    });
    expect(inline?.at(-1)).toEqual({
      type: "acme.chip",
      marks: [{ type: "strike" }],
    });
    expect(markdown.serialize({ ...document, source: undefined })).toBe(source);
  });

  it("prints a marked node that has no Markdown form as a generic tag", () => {
    const markdown = createMarkdownService(new Context());
    markdown.register(mentionCodec);
    const mention = {
      type: "acme.mention",
      attrs: { user: "ada" },
      marks: [{ type: "code" }],
    };
    const printed = markdown.serialize({
      body: {
        id: "d",
        type: "doc",
        v: 1,
        attrs: {},
        content: [
          { id: "p", type: "paragraph", v: 1, attrs: {}, inline: [mention] },
        ],
      },
    });
    expect(printed).toMatch(/^:inline\{/);
    expect(markdown.parse(printed).body.content?.[0]?.inline).toEqual([
      mention,
    ]);
  });

  it("lets a codec print a block in the generic tag syntax", () => {
    const markdown = createMarkdownService(new Context());
    markdown.register({
      name: "acme.boxes",
      claims: [],
      blockTypes: ["acme.box"],
      fromBlock: (block, context) => context.toGeneric(block),
    });
    const box: BlockNode = {
      id: "b",
      type: "acme.box",
      v: 2,
      attrs: { tone: "warn" },
      content: [
        {
          id: "p",
          type: "paragraph",
          v: 1,
          attrs: {},
          inline: [{ type: "text", text: "hi" }],
        },
      ],
    };
    const printed = markdown.serialize({
      body: { id: "d", type: "doc", v: 1, attrs: {}, content: [box] },
    });
    expect(printed).toBe(
      ':::block{type="acme.box" v="2" tone="warn"}\nhi\n:::\n',
    );
    const [parsed] = markdown.parse(printed).body.content ?? [];
    expect(parsed).toMatchObject({ type: "acme.box", v: 2, attrs: box.attrs });
  });

  it("keeps pipes out of generic tags, where they would split a table cell", () => {
    const markdown = createMarkdownService(new Context());
    const chip = {
      type: "acme.chip",
      text: "a|b",
      attrs: { label: "x|y", list: ["|"] },
    };
    const printed = markdown.serialize({
      body: {
        id: "d",
        type: "doc",
        v: 1,
        attrs: {},
        content: [
          { id: "p", type: "paragraph", v: 1, attrs: {}, inline: [chip] },
        ],
      },
    });
    expect(printed).not.toContain("|");
    expect(markdown.parse(printed).body.content?.[0]?.inline).toEqual([chip]);
  });
});
