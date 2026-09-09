// ============================================================
// Supabase pagination helpers.
//
// PostgREST caps an unbounded `.select()` at 1,000 rows (the
// `max-rows` setting) and returns the truncated page with NO error —
// so any query that can match more than 1,000 rows silently loses the
// rest. That is the root cause of a broadcast to ~1,978 contacts only
// reaching 1,000. These helpers make "read everything" explicit.
//
//   fetchAllRows  — page a range query (.range(from, to)) until a short
//                   page arrives. Use for any query whose result set can
//                   exceed 1,000 rows (e.g. contact_tags by tag_id).
//   selectInChunks — split a large `.in(col, values)` list into chunks
//                   and concatenate. Use ONLY when the `.in` column is
//                   unique (contacts.id, contacts.phone_normalized), so
//                   each chunk returns at most `chunkSize` rows; a
//                   non-unique column could exceed the page cap within a
//                   single chunk — use fetchAllRows there instead.
// ============================================================

/**
 * Minimal shape of a PostgREST list response. Structurally compatible
 * with what the Supabase query builder resolves to (`PostgrestError`
 * has a `message`), so call sites can hand us a builder directly.
 */
export interface PostgrestListResult<T> {
  data: T[] | null;
  error: { message: string } | null;
}

/**
 * Read every row a range query can return, paging past PostgREST's
 * 1,000-row cap. `buildRangeQuery` must apply `.range(from, to)` to a
 * fresh query each call (filters/order rebuilt inside it). Stops when a
 * page comes back shorter than `pageSize` — the last page. Propagates
 * the first error verbatim so call sites keep their existing messages.
 *
 * IMPORTANT: order by a DETERMINISTIC TOTAL ORDER — i.e. end the sort on
 * a unique column (typically `id`). Offset paging issues one
 * `OFFSET/LIMIT` query per page, so if the ORDER BY has ties, Postgres
 * may order the tied rows differently per page: the same row then appears
 * on two pages (duplicates) while others are skipped (gaps). This bites
 * hardest on rows bulk-inserted in one transaction, where a `created_at
 * DEFAULT now()` column is identical for every row and thus fully tied.
 * A query with no `.order()` at all is only safe when the caller collapses
 * the result into a set/dedupes by a key downstream.
 */
export async function fetchAllRows<T>(
  buildRangeQuery: (from: number, to: number) => PromiseLike<PostgrestListResult<T>>,
  pageSize = 1000,
): Promise<PostgrestListResult<T>> {
  const all: T[] = [];
  let from = 0;

  for (;;) {
    const to = from + pageSize - 1;
    const { data, error } = await buildRangeQuery(from, to);
    if (error) return { data: null, error };

    const page = data ?? [];
    all.push(...page);

    // A short (or empty) page means we've read the tail. A full page
    // means there may be more — advance and fetch again (a table whose
    // size is an exact multiple of pageSize costs one extra empty read).
    if (page.length < pageSize) break;
    from += pageSize;
  }

  return { data: all, error: null };
}

/**
 * Run a `.in(column, chunk)` query over a large value list in chunks,
 * concatenating the results. Avoids both the 1,000-row page cap and the
 * URL-length limit of a single huge `.in(...)`. Safe only for a UNIQUE
 * lookup column, where each chunk of size N returns at most N rows.
 * Propagates the first error verbatim.
 */
export async function selectInChunks<T>(
  makeQuery: (chunk: string[]) => PromiseLike<PostgrestListResult<T>>,
  values: string[],
  chunkSize = 500,
): Promise<PostgrestListResult<T>> {
  const all: T[] = [];

  for (let i = 0; i < values.length; i += chunkSize) {
    const chunk = values.slice(i, i + chunkSize);
    if (chunk.length === 0) continue;
    const { data, error } = await makeQuery(chunk);
    if (error) return { data: null, error };
    all.push(...(data ?? []));
  }

  return { data: all, error: null };
}
