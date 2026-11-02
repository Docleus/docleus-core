/** A page as a search collection stores it. */
export interface SearchDocument {
  readonly spaceId: string;
  readonly entryId: string;
  /** The revision the text was taken from. */
  readonly revision: string;
  readonly title: string;
  /** Plain searchable text of the body, from `ctx.blocks.text`. */
  readonly text: string;
  /**
   * Where the page is shown, such as its site-relative URL path in a site
   * collection. Stored and returned with the hit; never searched.
   */
  readonly path?: string;
}

/** Input of `search.query`. */
export interface SearchQuery {
  /** The user's query; matched as words, the last one also as a prefix. */
  readonly text: string;
  /** Only documents of these spaces. An empty list matches nothing. */
  readonly spaceIds: readonly string[];
  /** Defaults to 20; at most 100. */
  readonly limit?: number;
}

/** A document that matched a query. */
export interface SearchHit {
  readonly spaceId: string;
  readonly entryId: string;
  readonly revision: string;
  readonly title: string;
  /** The document's `path`, when it has one. */
  readonly path?: string;
  /** Plain text around the best match; never HTML. */
  readonly snippet: string;
  /** Higher is better; only comparable within one result list. */
  readonly score: number;
}

/**
 * Full-text search over named collections of pages, such as the heads of
 * `main` or the pages of a site's active publication. Documents are keyed by
 * collection, space and entry. Provided by a plugin (`docleus-plugin-search-db`,
 * or a search engine plugin); the content to index comes from projections.
 *
 * @stability experimental
 */
export interface SearchService {
  /** Adds documents or replaces those with the same key. */
  index(
    collection: string,
    documents: readonly SearchDocument[],
  ): Promise<void>;
  /** Removes the given entries of a space, or all of the space when `entryIds` is omitted. */
  remove(
    collection: string,
    spaceId: string,
    entryIds?: readonly string[],
  ): Promise<void>;
  /** Removes every document of `collection`. */
  clear(collection: string): Promise<void>;
  /** Best hits first; an empty or whitespace-only query returns no hits. */
  query(collection: string, query: SearchQuery): Promise<SearchHit[]>;
}
