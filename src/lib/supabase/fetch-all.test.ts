import { describe, it, expect, vi } from 'vitest';
import {
  fetchAllRows,
  selectInChunks,
  type PostgrestListResult,
} from './fetch-all';

// Mimics PostgREST's inclusive `.range(from, to)` slicing over a fixed
// backing array, so we can assert exactly how the loop pages.
function pagedSource<T>(rows: T[]) {
  return (from: number, to: number): Promise<PostgrestListResult<T>> =>
    Promise.resolve({ data: rows.slice(from, to + 1), error: null });
}

describe('fetchAllRows', () => {
  it('returns everything in a single short page and asks for one range', async () => {
    const spy = vi.fn(pagedSource([1, 2, 3]));
    const { data, error } = await fetchAllRows(spy, 10);

    expect(error).toBeNull();
    expect(data).toEqual([1, 2, 3]);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith(0, 9);
  });

  it('pages until a short page and concatenates in order', async () => {
    const rows = Array.from({ length: 25 }, (_, i) => i);
    const spy = vi.fn(pagedSource(rows));
    const { data } = await fetchAllRows(spy, 10);

    expect(data).toEqual(rows);
    // 10 + 10 + 5 → three reads, the last one short.
    expect(spy.mock.calls).toEqual([
      [0, 9],
      [10, 19],
      [20, 29],
    ]);
  });

  it('does one extra empty read when the total is an exact multiple of the page size', async () => {
    const rows = Array.from({ length: 20 }, (_, i) => i);
    const spy = vi.fn(pagedSource(rows));
    const { data } = await fetchAllRows(spy, 10);

    expect(data).toEqual(rows);
    // Two full pages look like "there may be more", so a third (empty)
    // read is needed to confirm the tail. This is the documented cost.
    expect(spy).toHaveBeenCalledTimes(3);
  });

  it('propagates the first error and stops paging', async () => {
    const spy = vi.fn(
      (from: number): Promise<PostgrestListResult<number>> =>
        from === 0
          ? Promise.resolve({ data: null, error: { message: 'boom' } })
          : Promise.resolve({ data: [], error: null }),
    );
    const { data, error } = await fetchAllRows(spy, 10);

    expect(data).toBeNull();
    expect(error).toEqual({ message: 'boom' });
    expect(spy).toHaveBeenCalledTimes(1);
  });
});

describe('selectInChunks', () => {
  it('splits a large .in list into chunks and concatenates the results', async () => {
    const values = Array.from({ length: 12 }, (_, i) => `v${i}`);
    const seen: string[][] = [];
    const { data, error } = await selectInChunks(
      (chunk) => {
        seen.push(chunk);
        return Promise.resolve({
          data: chunk.map((v) => ({ id: v })),
          error: null,
        });
      },
      values,
      5,
    );

    expect(error).toBeNull();
    expect(seen).toEqual([
      values.slice(0, 5),
      values.slice(5, 10),
      values.slice(10, 12),
    ]);
    expect(data).toEqual(values.map((v) => ({ id: v })));
  });

  it('propagates the first chunk error without running later chunks', async () => {
    const calls: string[][] = [];
    const { data, error } = await selectInChunks(
      (chunk) => {
        calls.push(chunk);
        return Promise.resolve({ data: null, error: { message: 'nope' } });
      },
      ['a', 'b', 'c'],
      2,
    );

    expect(data).toBeNull();
    expect(error).toEqual({ message: 'nope' });
    expect(calls).toHaveLength(1);
  });

  it('returns empty data for an empty value list without querying', async () => {
    const spy = vi.fn(
      (): Promise<PostgrestListResult<{ id: string }>> =>
        Promise.resolve({ data: [], error: null }),
    );
    const { data, error } = await selectInChunks(spy, [], 5);

    expect(error).toBeNull();
    expect(data).toEqual([]);
    expect(spy).not.toHaveBeenCalled();
  });
});
