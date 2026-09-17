import { describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

import { BroadcastError } from './broadcast-core';
import {
  claimBroadcastDelivery,
  planBroadcastResume,
  releaseBroadcastDelivery,
  touchBroadcastDelivery,
  DELIVERY_HEARTBEAT_MS,
  DELIVERY_LOCK_STALE_MS,
  RESUME_MAX_PER_REQUEST,
} from './broadcast-resume';

vi.mock('@/lib/whatsapp/encryption', () => ({
  decrypt: (v: string) => `decrypted:${v}`,
}));

// ============================================================
// Claim / release — the mutex that stops a double-send.
// ============================================================

interface ClaimCall {
  update: Record<string, unknown>;
  filters: Record<string, unknown>;
  or?: string;
}

function claimDb(returnedRows: unknown[], calls: ClaimCall[]): SupabaseClient {
  return {
    from() {
      const call: ClaimCall = { update: {}, filters: {} };
      const b: Record<string, unknown> = {
        update: (row: Record<string, unknown>) => {
          call.update = row;
          calls.push(call);
          return b;
        },
        eq: (col: string, val: unknown) => {
          call.filters[col] = val;
          return b;
        },
        or: (expr: string) => {
          call.or = expr;
          return b;
        },
        select: async () => ({ data: returnedRows, error: null }),
        then: (resolve: (r: { error: null }) => unknown) =>
          resolve({ error: null }),
      };
      return b;
    },
  } as unknown as SupabaseClient;
}

describe('claimBroadcastDelivery', () => {
  it('claims when the conditional UPDATE matched a row', async () => {
    const calls: ClaimCall[] = [];
    const ok = await claimBroadcastDelivery(
      claimDb([{ id: 'bc-1' }], calls),
      'acct-1',
      'bc-1',
      new Date('2026-08-11T12:00:00Z'),
    );

    expect(ok).toBe(true);
    expect(calls[0].filters).toEqual({ id: 'bc-1', account_id: 'acct-1' });
    expect(calls[0].update.delivery_locked_at).toBe(
      '2026-08-11T12:00:00.000Z',
    );
  });

  it('refuses when another pass already holds the lock', async () => {
    // The UPDATE's WHERE didn't match — someone else got there first.
    const ok = await claimBroadcastDelivery(
      claimDb([], []),
      'acct-1',
      'bc-1',
    );
    expect(ok).toBe(false);
  });

  it('treats a lock older than the staleness window as abandoned', async () => {
    const calls: ClaimCall[] = [];
    const now = new Date('2026-08-11T12:00:00Z');
    await claimBroadcastDelivery(
      claimDb([{ id: 'bc-1' }], calls),
      'acct-1',
      'bc-1',
      now,
    );
    // The cutoff is derived from the constant rather than hard-coded, so
    // tuning the window can't silently leave this test asserting the old
    // one. A pass whose process died is recoverable without touching the
    // database by hand.
    const cutoff = new Date(
      now.getTime() - DELIVERY_LOCK_STALE_MS,
    ).toISOString();
    expect(calls[0].or).toBe(
      `delivery_locked_at.is.null,delivery_locked_at.lt.${cutoff}`,
    );
  });

  it('expires an abandoned lock quickly enough to be usable after a restart', async () => {
    // The lock lives in the database, so it survives the process that
    // took it: a server restart mid-fan-out leaves the stamp behind and
    // Resume stays refused until the window elapses. It used to be 30
    // minutes, which read to operators as "restarting doesn't help".
    expect(DELIVERY_LOCK_STALE_MS).toBeLessThanOrEqual(5 * 60 * 1000);
    // ...but a live pass proves itself on a much shorter cadence, so a
    // couple of dropped heartbeats can never look like a dead process.
    expect(DELIVERY_HEARTBEAT_MS * 3).toBeLessThanOrEqual(
      DELIVERY_LOCK_STALE_MS,
    );
  });

  it('is scoped to the account, so another tenant cannot claim it', async () => {
    const calls: ClaimCall[] = [];
    await claimBroadcastDelivery(claimDb([], calls), 'acct-9', 'bc-1');
    expect(calls[0].filters.account_id).toBe('acct-9');
  });
});

describe('releaseBroadcastDelivery', () => {
  it('clears the lock', async () => {
    const calls: ClaimCall[] = [];
    await releaseBroadcastDelivery(claimDb([], calls), 'bc-1');
    expect(calls[0].update).toEqual({ delivery_locked_at: null });
    expect(calls[0].filters).toEqual({ id: 'bc-1' });
  });
});

describe('touchBroadcastDelivery', () => {
  it('re-stamps the lock so a long pass is never judged abandoned', async () => {
    const calls: ClaimCall[] = [];
    const before = Date.now();
    await touchBroadcastDelivery(claimDb([], calls), 'bc-1');

    expect(calls[0].filters).toEqual({ id: 'bc-1' });
    const stamped = Date.parse(
      calls[0].update.delivery_locked_at as string,
    );
    expect(stamped).toBeGreaterThanOrEqual(before);
    // Crucially it does NOT filter on account_id or on the lock's
    // current value: the pass already proved ownership when it claimed
    // the lock, and a heartbeat that could fail to match would let a
    // healthy send lose a lock it legitimately holds.
    expect(calls[0].or).toBeUndefined();
  });
});

// ============================================================
// Planning — which recipients a pass picks up, and with what params.
// ============================================================

interface PlanFixture {
  broadcast?: Record<string, unknown> | null;
  recipients?: Record<string, unknown>[];
  config?: Record<string, unknown> | null;
  templates?: Record<string, unknown>[];
}

interface PlanWrites {
  statusFilter?: unknown;
  failedIds?: unknown;
  failedUpdate?: Record<string, unknown>;
}

function planDb(fx: PlanFixture, writes: PlanWrites = {}): SupabaseClient {
  return {
    from(table: string) {
      // Per-builder range window, so fetchAllRows can page the recipient
      // read. A fresh from() → fresh window, so the unsendable UPDATE
      // (also on broadcast_recipients) never inherits a stale range.
      let rangeFrom: number | null = null;
      let rangeTo: number | null = null;
      const b: Record<string, unknown> = {
        select: () => b,
        eq: () => b,
        order: () => b,
        range: (from: number, to: number) => {
          rangeFrom = from;
          rangeTo = to;
          return b;
        },
        in: (col: string, vals: unknown) => {
          if (col === 'status') writes.statusFilter = vals;
          if (col === 'id') writes.failedIds = vals;
          return b;
        },
        update: (row: Record<string, unknown>) => {
          writes.failedUpdate = row;
          return b;
        },
        maybeSingle: async () => ({
          data: fx.broadcast === undefined ? null : fx.broadcast,
          error: null,
        }),
        single: async () => ({
          data: fx.config === undefined ? null : fx.config,
          error: null,
        }),
        then: (resolve: (r: { data: unknown[]; error: null }) => unknown) => {
          if (table === 'broadcast_recipients') {
            const all = fx.recipients ?? [];
            // Emulate PostgREST: an unbounded select is truncated to 1,000
            // with no error (the whole reason resume must page), while a
            // .range(from,to) returns exactly that inclusive window.
            const page =
              rangeFrom === null
                ? all.slice(0, 1000)
                : all.slice(rangeFrom, rangeTo! + 1);
            return resolve({ data: page, error: null });
          }
          if (table === 'message_templates') {
            return resolve({ data: fx.templates ?? [], error: null });
          }
          return resolve({ data: [], error: null });
        },
      };
      return b;
    },
  } as unknown as SupabaseClient;
}

const BROADCAST = {
  id: 'bc-1',
  template_name: 'order_update',
  template_language: 'en_US',
};

const CONFIG = { phone_number_id: 'pn-1', access_token: 'tok' };

function recipient(
  id: string,
  phone: string | null,
  params: unknown = ['A123'],
) {
  return {
    id,
    template_params: params,
    contact: phone ? { phone } : null,
  };
}

describe('planBroadcastResume', () => {
  it('plans the outstanding recipients with their frozen params', async () => {
    const writes: PlanWrites = {};
    const { plan, remaining, unsendable } = await planBroadcastResume(
      planDb(
        {
          broadcast: BROADCAST,
          config: CONFIG,
          recipients: [
            recipient('r1', '+15551234567', ['A123', 'Friday']),
            recipient('r2', '+15559876543', ['B456', 'Monday']),
          ],
        },
        writes,
      ),
      'acct-1',
      'bc-1',
      'pending',
    );

    expect(writes.statusFilter).toEqual(['pending']);
    // Phones are stored sanitized (no leading '+'), same as the shape
    // createBroadcast plans — deliverBroadcast feeds them to
    // phoneVariants from here.
    expect(plan.planned).toEqual([
      {
        recipientRowId: 'r1',
        phone: '15551234567',
        params: ['A123', 'Friday'],
      },
      {
        recipientRowId: 'r2',
        phone: '15559876543',
        params: ['B456', 'Monday'],
      },
    ]);
    expect(plan.accessToken).toBe('decrypted:tok');
    expect(remaining).toBe(0);
    expect(unsendable).toBe(0);
  });

  it('scopes to failed rows when retrying, and to both for "all"', async () => {
    const failedWrites: PlanWrites = {};
    await planBroadcastResume(
      planDb(
        {
          broadcast: BROADCAST,
          config: CONFIG,
          recipients: [recipient('r1', '+15551234567')],
        },
        failedWrites,
      ),
      'acct-1',
      'bc-1',
      'failed',
    );
    expect(failedWrites.statusFilter).toEqual(['failed']);

    const allWrites: PlanWrites = {};
    await planBroadcastResume(
      planDb(
        {
          broadcast: BROADCAST,
          config: CONFIG,
          recipients: [recipient('r1', '+15551234567')],
        },
        allWrites,
      ),
      'acct-1',
      'bc-1',
      'all',
    );
    expect(allWrites.statusFilter).toEqual(['pending', 'failed']);
  });

  it('treats a missing or malformed params column as no params', async () => {
    const { plan } = await planBroadcastResume(
      planDb({
        broadcast: BROADCAST,
        config: CONFIG,
        recipients: [
          // Rows created before migration 038 carry NULL.
          recipient('r1', '+15551234567', null),
          recipient('r2', '+15559876543', 'not-an-array'),
        ],
      }),
      'acct-1',
      'bc-1',
      'pending',
    );
    expect(plan.planned.map((p) => p.params)).toEqual([[], []]);
  });

  it('fails unsendable rows up front so they stop blocking the status', async () => {
    const writes: PlanWrites = {};
    const { plan, unsendable } = await planBroadcastResume(
      planDb(
        {
          broadcast: BROADCAST,
          config: CONFIG,
          recipients: [
            recipient('r1', '+15551234567'),
            recipient('r2', null),
            recipient('r3', 'nonsense'),
          ],
        },
        writes,
      ),
      'acct-1',
      'bc-1',
      'pending',
    );

    // Left 'pending', these would keep the broadcast in 'sending'
    // forever — the exact symptom being fixed.
    expect(unsendable).toBe(2);
    expect(writes.failedIds).toEqual(['r2', 'r3']);
    expect(writes.failedUpdate?.status).toBe('failed');
    expect(plan.planned).toHaveLength(1);
  });

  it('reads every outstanding recipient past the 1,000-row cap', async () => {
    // The 6,657-recipient report: a single unpaginated select stops at
    // 1,000, so resume picked up 1,000, reported "0 remaining", and left
    // the rest stranded 'pending'. planBroadcastResume must page. The mock
    // truncates an un-ranged read to 1,000 (as PostgREST does), so this
    // length is only reachable if fetchAllRows walked every page.
    const many = Array.from({ length: 2345 }, (_, i) =>
      recipient(`r${i}`, '+1555' + String(2000000 + i)),
    );
    const { plan, remaining } = await planBroadcastResume(
      planDb({ broadcast: BROADCAST, config: CONFIG, recipients: many }),
      'acct-1',
      'bc-1',
      'pending',
    );
    // All 2,345 are under the 10,000 per-pass cap, so every one is planned.
    expect(plan.planned).toHaveLength(2345);
    expect(remaining).toBe(0);
  });

  it('caps one pass and reports the leftover', async () => {
    const many = Array.from({ length: RESUME_MAX_PER_REQUEST + 25 }, (_, i) =>
      recipient(`r${i}`, '+1555000' + String(i).padStart(4, '0')),
    );
    const { plan, remaining } = await planBroadcastResume(
      planDb({ broadcast: BROADCAST, config: CONFIG, recipients: many }),
      'acct-1',
      'bc-1',
      'pending',
    );
    expect(plan.planned).toHaveLength(RESUME_MAX_PER_REQUEST);
    // Surfaced to the caller rather than silently dropped.
    expect(remaining).toBe(25);
  });

  it('404s a broadcast that is not on this account', async () => {
    await expect(
      planBroadcastResume(
        planDb({ broadcast: null }),
        'acct-1',
        'bc-1',
        'pending',
      ),
    ).rejects.toMatchObject({ status: 404 });
  });

  it('refuses when there is nothing outstanding', async () => {
    await expect(
      planBroadcastResume(
        planDb({ broadcast: BROADCAST, config: CONFIG, recipients: [] }),
        'acct-1',
        'bc-1',
        'failed',
      ),
    ).rejects.toBeInstanceOf(BroadcastError);
  });

  it('resolves the template row for header + button components', async () => {
    const { plan } = await planBroadcastResume(
      planDb({
        broadcast: { ...BROADCAST, template_language: 'en_US' },
        config: CONFIG,
        recipients: [recipient('r1', '+15551234567')],
        templates: [
          {
            id: 'tpl-1',
            user_id: 'u-1',
            name: 'order_update',
            // Synced from Meta as bare 'en' — the resolver bridges it.
            language: 'en',
            body_text: 'Your order {{1}} ships on {{2}}',
          },
        ],
      }),
      'acct-1',
      'bc-1',
      'pending',
    );
    expect(plan.templateRow?.language).toBe('en');
  });
});
