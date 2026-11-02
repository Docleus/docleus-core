/** Up to two initials of a name or email, for avatars. */
export function initials(name: string): string {
  const words = name
    .replace(/@.*/, "")
    .split(/[\s._-]+/)
    .filter(Boolean);
  const letters =
    words.length > 1
      ? (words[0]?.[0] ?? "") + (words.at(-1)?.[0] ?? "")
      : (words[0] ?? "?").slice(0, 2);
  return letters.toUpperCase();
}

/** `1 page`, `3 pages`. */
export function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? "" : "s"}`;
}

/** The first 7 characters of an id, for revisions and hashes. */
export function short(id: string): string {
  return id.replace(/-/g, "").slice(-7);
}

/** A slug from a name: `Platform handbook` → `platform-handbook`. */
export function slugify(name: string): string {
  return name
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, "-")
    .replaceAll(/^-|-$/g, "")
    .slice(0, 64);
}
