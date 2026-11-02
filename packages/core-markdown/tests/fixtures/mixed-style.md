---
# A comment the YAML printer would drop.
title:    "Mixed  style"
order: 3
tags: [ a,  b ]
---


Setext heading
==============

Some text with __underscore bold__, _underscore em_, *star em*,
a soft line break, `code`, ``code with ` tick``, ~one tilde~,
and a [reference link][ref] plus <https://autolink.example>.

* star bullets
*   wide bullet

1) paren list
2) second



   Indented paragraph after extra blank lines.

> quote
continued lazily

~~~python
def f():  
    return 1
~~~

    indented code

<!-- html comment -->
<details><summary>HTML block</summary>

Inner *markdown*.

</details>

Hard break with backslash\
and with two spaces  
end.

---

Line with trailing spaces   
:::block{type="acme.callout" tone='warn'}
Inside   *it*.
:::

::::block{type="acme.tabs"}
:::block{type="acme.tab" title=One}
First.
:::
::::

[ref]: https://example.com  "Title"
Last line without newline
	Tab-indented line inside a paragraph
