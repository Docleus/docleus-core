import { Context } from "@docleus/sdk";
import { describe, expect, it } from "vitest";
import { convertGitbookTags, createMarkdownService } from "./index.ts";

describe("convertGitbookTags", () => {
  it("turns a block tag into a generic container tag", () => {
    expect(
      convertGitbookTags('{% hint style="warning" %}\nCareful.\n{% endhint %}'),
    ).toBe(':::block{type="gitbook.hint" style="warning"}\nCareful.\n:::');
  });

  it("widens the outer fence for nested tags", () => {
    expect(
      convertGitbookTags(
        "{% tabs %}\n{% tab title='One' %}\nA\n{% endtab %}\n{% endtabs %}",
      ),
    ).toBe(
      ':::::block{type="gitbook.tabs"}\n:::block{type="gitbook.tab" title="One"}\nA\n:::\n:::::',
    );
  });

  it("makes a tag without an end tag a leaf, keeping positional arguments", () => {
    expect(convertGitbookTags('{% embed url="https://x.test" %}\nAfter.')).toBe(
      '::block{type="gitbook.embed" url="https://x.test"}\nAfter.',
    );
    expect(convertGitbookTags("{% include 'a.md' %}")).toBe(
      '::block{type="gitbook.include" args="\'a.md\'"}',
    );
  });

  it("leaves tags inside fenced code alone", () => {
    const source = "```liquid\n{% hint %}\n```\n";
    expect(convertGitbookTags(source)).toBe(source);
  });

  it("leaves an end tag with no opening tag as text", () => {
    expect(convertGitbookTags("{% endhint %}")).toBe("{% endhint %}");
  });
});

describe("parse with gitbook", () => {
  const markdown = createMarkdownService(new Context());

  it("imports tags as gitbook blocks that export in the generic syntax", () => {
    const document = markdown.parse(
      '{% hint style="info" %}\nA *b*.\n{% endhint %}\n',
      {
        gitbook: true,
      },
    );
    const [hint] = document.body.content ?? [];
    expect(hint?.type).toBe("gitbook.hint");
    expect(hint?.content?.[0]?.type).toBe("paragraph");
    const exported = markdown.serialize({ ...document, source: undefined });
    expect(exported).toBe(
      ':::block{type="gitbook.hint" style="info"}\nA *b*.\n:::\n',
    );
  });

  it("leaves tags as text without the option", () => {
    const [block] = markdown.parse("{% hint %}\n").body.content ?? [];
    expect(block?.type).toBe("paragraph");
  });
});
