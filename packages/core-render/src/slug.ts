/** A lowercase slug of `text` without accents, or `section` when nothing is left. */
export function slugify(text: string): string {
  const slug = text
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^\p{Letter}\p{Number}]+/gu, "-")
    .replace(/^-+|-+$/g, "");
  return slug === "" ? "section" : slug;
}

/** Returns slugs unique among those it returned: `usage`, `usage-2`, ... */
export function createSlugger(): (text: string) => string {
  const taken = new Set<string>();
  return (text) => {
    const base = slugify(text);
    let slug = base;
    for (let n = 2; taken.has(slug); n++) slug = `${base}-${n}`;
    taken.add(slug);
    return slug;
  };
}
