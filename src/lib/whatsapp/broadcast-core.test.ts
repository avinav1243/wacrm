import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  createBroadcast,
  deliverBroadcast,
  finalizeBroadcastStatus,
  BroadcastError,
  type BroadcastPlan,
} from './broadcast-core';
import { sendTemplateMessage } from '@/lib/whatsapp/meta-api';
import { MAX_BROADCAST_RECIPIENTS } from '@/lib/broadcast-limits';

// Contact resolution and token decryption are exercised elsewhere — stub
// them so these tests focus on the persistence boundary.
vi.mock('@/lib/whatsapp/encryption', () => ({
  decrypt: () => 'plain-access-token',
}));
vi.mock('@/lib/api/v1/contacts', () => ({
  findOrCreateContact: vi.fn(async () => ({ id: 'c1' })),
}));
// The fan-out's only outbound call. Stubbing it lets the pool tests below
// observe concurrency, ordering, and per-recipient failure without a
// network round-trip.
vi.mock('@/lib/whatsapp/meta-api', () => ({
  sendTemplateMessage: vi.fn(),
}));
const sendMock = vi.mocked(sendTemplateMessage);

// These assertions all fire in the pure validation prologue, before
// any Supabase call — a bare stub is enough.
const db = {} as SupabaseClient;

describe('createBroadcast validation', () => {
  it('rejects a missing template_name', async () => {
    await expect(
      createBroadcast(db, 'acc', 'user', {
        templateName: '',
        recipients: [{ to: '+14155550123' }],
      })
    ).rejects.toMatchObject({ code: 'bad_request', status: 400 });
  });

  it('rejects an empty recipient list', async () => {
    await expect(
      createBroadcast(db, 'acc', 'user', {
        templateName: 'promo',
        recipients: [],
      })
    ).rejects.toBeInstanceOf(BroadcastError);
  });

  it('rejects more than the recipient cap', async () => {
    const recipients = Array.from(
      { length: MAX_BROADCAST_RECIPIENTS + 1 },
      () => ({ to: '+14155550123' }),
    );
    await expect(
      createBroadcast(db, 'acc', 'user', { templateName: 'promo', recipients })
    ).rejects.toMatchObject({ status: 400 });
  });
});

// Build a Supabase-shaped mock that gets createBroadcast past its config +
// template lookups and into persistence. `rpcResult` is what the atomic
// create_broadcast_with_recipients RPC returns.
function makeDb(rpcResult: { data: unknown; error: unknown }) {
  const calls = {
    rpc: [] as { name: string; args: unknown }[],
    // Incremented if the OLD non-atomic path (a direct broadcasts /
    // broadcast_recipients insert) is ever reached — it must not be.
    usedDirectInsert: 0,
  };
  const database = {
    from(table: string) {
      if (table === 'whatsapp_config') {
        return {
          select: () => ({
            eq: () => ({
              single: () =>
                Promise.resolve({
                  data: { phone_number_id: 'pn-1', access_token: 'enc' },
                  error: null,
                }),
            }),
          }),
        };
      }
      if (table === 'message_templates') {
        const chain: Record<string, unknown> = {
          select: () => chain,
          eq: () => chain,
          maybeSingle: () => Promise.resolve({ data: null, error: null }),
        };
        return chain;
      }
      if (table === 'broadcasts' || table === 'broadcast_recipients') {
        calls.usedDirectInsert++;
        return {
          insert: () => ({
            select: () => ({
              single: () =>
                Promise.resolve({ data: { id: 'orphan' }, error: null }),
            }),
          }),
        };
      }
      throw new Error(`unexpected table: ${table}`);
    },
    rpc(name: string, args: unknown) {
      calls.rpc.push({ name, args });
      return Promise.resolve(rpcResult);
    },
  } as unknown as SupabaseClient;
  return { db: database, calls };
}

describe('createBroadcast atomicity (#370)', () => {
  it('creates parent + recipients through the atomic RPC, never a bare parent insert', async () => {
    const { db, calls } = makeDb({
      data: [{ broadcast_id: 'b-1', recipient_id: 'r-1', contact_id: 'c1' }],
      error: null,
    });

    const plan = await createBroadcast(db, 'acc', 'user', {
      templateName: 'promo',
      recipients: [{ to: '+14155550123' }],
    });

    expect(calls.rpc).toHaveLength(1);
    expect(calls.rpc[0].name).toBe('create_broadcast_with_recipients');
    expect(calls.usedDirectInsert).toBe(0);
    expect(plan.broadcastId).toBe('b-1');
    expect(plan.planned).toEqual([
      { recipientRowId: 'r-1', phone: '14155550123', params: [] },
    ]);
  });

  it('throws and leaves no orphaned parent when the atomic create fails', async () => {
    const { db, calls } = makeDb({
      data: null,
      error: { message: 'recipient insert failed' },
    });

    await expect(
      createBroadcast(db, 'acc', 'user', {
        templateName: 'promo',
        recipients: [{ to: '+14155550123' }],
      })
    ).rejects.toBeInstanceOf(BroadcastError);

    // The RPC was the only persistence attempt; because it runs both
    // inserts in a single transaction, its failure rolls the parent back —
    // there is no separate parent insert that could survive as an orphan.
    expect(calls.rpc).toHaveLength(1);
    expect(calls.usedDirectInsert).toBe(0);
  });
});

// ============================================================
// Terminal status (#472). Derived from the recipient rows, not from a
// counter local to one delivery pass — a resume only sends the
// leftovers, so "nothing sent this pass" must not condemn a campaign
// that already delivered hundreds.
// ============================================================

function statusDb(
  counts: Record<string, number>,
  total: number,
  writes: { update?: Record<string, unknown> },
) {
  return {
    from(table: string) {
      let status: string | null = null;
      const b: Record<string, unknown> = {
        select: () => b,
        eq: (col: string, val: unknown) => {
          if (col === 'status') status = val as string;
          return b;
        },
        update: (row: Record<string, unknown>) => {
          if (table === 'broadcasts') writes.update = row;
          return b;
        },
        then: (resolve: (r: { count: number; error: null }) => unknown) =>
          resolve({
            count: status === null ? total : (counts[status] ?? 0),
            error: null,
          }),
      };
      return b;
    },
  } as unknown as SupabaseClient;
}

describe('finalizeBroadcastStatus', () => {
  it('leaves a capped pass in "sending" while recipients are still pending', async () => {
    const writes: { update?: Record<string, unknown> } = {};
    await finalizeBroadcastStatus(statusDb({ pending: 25 }, 1025, writes), 'b-1');
    // No write at all — the UI keeps offering Resume.
    expect(writes.update).toBeUndefined();
  });

  it('marks a fully-failed broadcast failed', async () => {
    const writes: { update?: Record<string, unknown> } = {};
    await finalizeBroadcastStatus(
      statusDb({ pending: 0, failed: 10 }, 10, writes),
      'b-1',
    );
    expect(writes.update?.status).toBe('failed');
  });

  it('marks a partially-failed broadcast sent', async () => {
    const writes: { update?: Record<string, unknown> } = {};
    await finalizeBroadcastStatus(
      statusDb({ pending: 0, failed: 3 }, 10, writes),
      'b-1',
    );
    // 7 people got the message; failed_count carries the other 3.
    expect(writes.update?.status).toBe('sent');
  });

  it('does not condemn a campaign whose resume pass sent nothing new', async () => {
    const writes: { update?: Record<string, unknown> } = {};
    // 800 delivered on the original pass, the 200-recipient resume all
    // failed. Pre-fix this wrote 'failed' off a pass-local counter.
    await finalizeBroadcastStatus(
      statusDb({ pending: 0, failed: 200 }, 1000, writes),
      'b-1',
    );
    expect(writes.update?.status).toBe('sent');
  });
});

// ============================================================
// deliverBroadcast — the concurrent, rate-metered fan-out.
//
// The pool replaced a strictly-sequential loop in which one slow (or
// hung) Meta call froze every remaining recipient. These tests pin the
// properties that make the pool safe: no recipient is dropped or sent
// twice, in-flight sends never exceed `concurrency`, one failed send
// never strands the rest, and the liveness heartbeat runs for exactly as
// long as the pass does.
// ============================================================

interface DeliverRecord {
  updates: { id: string; row: Record<string, unknown> }[];
}

// A Supabase-shaped mock covering both operations deliverBroadcast
// performs: the per-recipient row stamp (a broadcast_recipients UPDATE …
// eq('id')) and finalizeBroadcastStatus's count reads. Count reads report
// nothing pending so finalize proceeds without any of these tests having
// to model the terminal-status arithmetic (that lives in its own suite).
function deliverDb(record: DeliverRecord): SupabaseClient {
  return {
    from(table: string) {
      let isSelect = false;
      let updateRow: Record<string, unknown> | null = null;
      let rowId: string | null = null;
      const b: Record<string, unknown> = {
        select: () => {
          isSelect = true;
          return b;
        },
        update: (row: Record<string, unknown>) => {
          updateRow = row;
          return b;
        },
        eq: (col: string, val: unknown) => {
          if (col === 'id' && table === 'broadcast_recipients') {
            rowId = val as string;
          }
          return b;
        },
        then: (resolve: (r: unknown) => unknown) => {
          if (isSelect) return resolve({ count: 0, error: null });
          if (table === 'broadcast_recipients' && updateRow && rowId) {
            record.updates.push({ id: rowId, row: updateRow });
          }
          return resolve({ error: null });
        },
      };
      return b;
    },
  } as unknown as SupabaseClient;
}

function makePlan(n: number): BroadcastPlan {
  return {
    broadcastId: 'b-1',
    templateName: 'promo',
    templateLanguage: 'en_US',
    phoneNumberId: 'pn-1',
    accessToken: 'tok',
    templateRow: null,
    planned: Array.from({ length: n }, (_, i) => ({
      recipientRowId: `r${i}`,
      // Distinct, so a per-recipient reject can be keyed by phone and no
      // phoneVariants trunk-0 permutation collides with another number.
      phone: `1555${1000000 + i}`,
      params: [],
    })),
    rejected: 0,
  };
}

describe('deliverBroadcast pool', () => {
  beforeEach(() => {
    sendMock.mockReset();
  });

  it('delivers every planned recipient exactly once — no drops, no doubles', async () => {
    sendMock.mockImplementation(async () => ({ messageId: 'wamid.OK' }));
    const record: DeliverRecord = { updates: [] };
    const plan = makePlan(25);

    await deliverBroadcast(deliverDb(record), plan, {
      maxPerSecond: 0,
      concurrency: 8,
    });

    // One send per recipient (the first phone variant succeeds).
    expect(sendMock).toHaveBeenCalledTimes(25);
    // Every recipient row stamped once, all 'sent', ids exactly the plan.
    expect(record.updates).toHaveLength(25);
    expect(record.updates.every((u) => u.row.status === 'sent')).toBe(true);
    expect(new Set(record.updates.map((u) => u.id))).toEqual(
      new Set(plan.planned.map((p) => p.recipientRowId)),
    );
  });

  it('never runs more than `concurrency` sends in flight', async () => {
    let inFlight = 0;
    let peak = 0;
    sendMock.mockImplementation(async () => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      // A real macrotask so overlapping sends genuinely coexist.
      await new Promise((r) => setTimeout(r, 1));
      inFlight--;
      return { messageId: 'wamid.OK' };
    });

    await deliverBroadcast(deliverDb({ updates: [] }), makePlan(20), {
      maxPerSecond: 0,
      concurrency: 4,
    });

    expect(peak).toBeLessThanOrEqual(4);
    // ...and it really did fan out, rather than accidentally serializing.
    expect(peak).toBeGreaterThan(1);
  });

  it('caps workers at the recipient count for a tiny plan', async () => {
    let inFlight = 0;
    let peak = 0;
    sendMock.mockImplementation(async () => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 1));
      inFlight--;
      return { messageId: 'wamid.OK' };
    });

    await deliverBroadcast(deliverDb({ updates: [] }), makePlan(2), {
      maxPerSecond: 0,
      concurrency: 8,
    });

    // Only 2 recipients, so at most 2 sends can ever overlap.
    expect(peak).toBeLessThanOrEqual(2);
  });

  it('stamps a failed send and still delivers the rest (the freeze regression)', async () => {
    const plan = makePlan(5);
    const doomedPhone = plan.planned[2].phone;
    sendMock.mockImplementation(async (args: { to: string }) => {
      if (args.to === doomedPhone) {
        throw new Error('permanent failure from Meta');
      }
      return { messageId: 'wamid.OK' };
    });
    const record: DeliverRecord = { updates: [] };

    await deliverBroadcast(deliverDb(record), plan, {
      maxPerSecond: 0,
      concurrency: 3,
    });

    const byId = new Map(record.updates.map((u) => [u.id, u.row]));
    expect(byId.get('r2')?.status).toBe('failed');
    expect(byId.get('r2')?.error_message).toBe('permanent failure from Meta');
    // The other four were not stranded behind the failure.
    for (const i of [0, 1, 3, 4]) {
      expect(byId.get(`r${i}`)?.status).toBe('sent');
    }
    expect(record.updates).toHaveLength(5);
  });

  it('one worker throwing (a DB fault) does not strand the rest of its queue', async () => {
    sendMock.mockImplementation(async () => ({ messageId: 'wamid.OK' }));
    const record: DeliverRecord = { updates: [] };
    const plan = makePlan(6);
    // A db whose recipient UPDATE throws for one row — this escapes
    // deliverOne, and the worker's .catch must swallow it so the shared
    // cursor keeps feeding the remaining recipients.
    const db = {
      from(table: string) {
        let isSelect = false;
        let updateRow: Record<string, unknown> | null = null;
        let rowId: string | null = null;
        const b: Record<string, unknown> = {
          select: () => {
            isSelect = true;
            return b;
          },
          update: (row: Record<string, unknown>) => {
            updateRow = row;
            return b;
          },
          eq: (col: string, val: unknown) => {
            if (col === 'id' && table === 'broadcast_recipients') {
              rowId = val as string;
            }
            return b;
          },
          then: (
            resolve: (r: unknown) => unknown,
            reject: (e: unknown) => unknown,
          ) => {
            if (isSelect) return resolve({ count: 0, error: null });
            if (rowId === 'r3') return reject(new Error('db write blew up'));
            if (table === 'broadcast_recipients' && updateRow && rowId) {
              record.updates.push({ id: rowId, row: updateRow });
            }
            return resolve({ error: null });
          },
        };
        return b;
      },
    } as unknown as SupabaseClient;

    await expect(
      deliverBroadcast(db, plan, { maxPerSecond: 0, concurrency: 2 }),
    ).resolves.toBeUndefined();

    // r3's stamp threw, so it isn't recorded — but all five others are.
    expect(record.updates.map((u) => u.id).sort()).toEqual([
      'r0',
      'r1',
      'r2',
      'r4',
      'r5',
    ]);
  });

  it('fires onHeartbeat on its interval during the pass and clears it after', async () => {
    vi.useFakeTimers();
    try {
      // Park every send on a gate we control, so the pass stays in flight
      // while we advance the clock across several heartbeat intervals.
      let release!: () => void;
      const gate = new Promise<void>((r) => {
        release = r;
      });
      sendMock.mockImplementation(async () => {
        await gate;
        return { messageId: 'wamid.OK' };
      });
      const heartbeat = vi.fn(async () => {});

      const pass = deliverBroadcast(deliverDb({ updates: [] }), makePlan(1), {
        maxPerSecond: 0,
        onHeartbeat: heartbeat,
        heartbeatIntervalMs: 1000,
      });

      await vi.advanceTimersByTimeAsync(3500);
      expect(heartbeat).toHaveBeenCalledTimes(3);

      release();
      await pass;

      // The finally cleared the interval, so the clock advancing further
      // produces no more keepalives.
      const settled = heartbeat.mock.calls.length;
      await vi.advanceTimersByTimeAsync(5000);
      expect(heartbeat.mock.calls.length).toBe(settled);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does no keepalive writes when no onHeartbeat is supplied', async () => {
    sendMock.mockImplementation(async () => ({ messageId: 'wamid.OK' }));
    // Simply must not throw when the timer is never created.
    await expect(
      deliverBroadcast(deliverDb({ updates: [] }), makePlan(3), {
        maxPerSecond: 0,
      }),
    ).resolves.toBeUndefined();
  });
});
