// ============================================================
// Public-API broadcast core.
//
// Splits a broadcast into two phases so the HTTP route can persist +
// acknowledge fast and fan out afterwards (in `after()`):
//
//   createBroadcast()  — validate, resolve contacts, insert the
//                        `broadcasts` row + `broadcast_recipients`
//                        rows (status 'pending'), return a plan.
//   deliverBroadcast() — send each recipient's template via Meta
//                        (phone-variant retry) from a small pool of
//                        rate-metered concurrent sends, stamp each
//                        recipient row, finalize status.
//
// Recipient rows carry `whatsapp_message_id`, so the inbound webhook's
// status handler (which matches on that column) updates delivered/read
// for API broadcasts exactly as it does for dashboard ones.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js';

import { sendTemplateMessage } from '@/lib/whatsapp/meta-api';
import { decrypt } from '@/lib/whatsapp/encryption';
import {
  sanitizePhoneForMeta,
  isValidE164,
  phoneVariants,
  isRecipientNotAllowedError,
  isRateLimitError,
} from '@/lib/whatsapp/phone-utils';
import { resolveTemplateRow } from '@/lib/whatsapp/template-body';
import type { MessageTemplate } from '@/types';
import { findOrCreateContact } from '@/lib/api/v1/contacts';
import { BATCH_SEND_ATTEMPTS, batchRetryDelayMs } from '@/lib/broadcast-retry';
import { MAX_BROADCAST_RECIPIENTS } from '@/lib/broadcast-limits';

/** Thrown by createBroadcast on a caller-visible failure; route maps it. */
export class BroadcastError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, message: string, status: number) {
    super(message);
    this.name = 'BroadcastError';
    this.code = code;
    this.status = status;
  }
}

export interface BroadcastRecipientInput {
  /** E.164 phone. */
  to: string;
  /** Positional body params for the template ({{1}}, {{2}}…). */
  params?: string[];
}

export interface CreateBroadcastParams {
  name?: string | null;
  templateName: string;
  templateLanguage?: string | null;
  recipients: BroadcastRecipientInput[];
}

interface PlannedRecipient {
  recipientRowId: string;
  phone: string;
  params: string[];
}

export interface BroadcastPlan {
  broadcastId: string;
  templateName: string;
  templateLanguage: string;
  phoneNumberId: string;
  accessToken: string;
  templateRow: MessageTemplate | null;
  planned: PlannedRecipient[];
  /** Phones rejected up front (invalid E.164) — counted as failed. */
  rejected: number;
}

/**
 * Per-request recipient cap, shared with the wizard + resume paths via
 * broadcast-limits. Matches the account's Meta 24-hour messaging tier.
 */
const MAX_RECIPIENTS = MAX_BROADCAST_RECIPIENTS;

/**
 * Server-side send pacing.
 *
 * Delivery used to be strictly sequential with a 1s pause every 10
 * sends. At the 10,000-recipient cap that is ~17 minutes of pure sleep
 * on top of 10,000 serialized Meta round-trips — over an hour per
 * campaign, an effective ~3 messages/second, and every minute of it a
 * window in which a restart strands the remainder.
 *
 * So instead: keep a few sends in flight and meter when each one
 * *starts*. SEND_MAX_PER_SECOND stays far below Meta's Cloud API
 * throughput (80 messages/second by default, upgradable to 500) — the
 * goal is finishing in minutes, not running at the ceiling. Note this
 * is unrelated to the account's 24-hour messaging limit
 * (MAX_BROADCAST_RECIPIENTS): that counts unique recipients per day,
 * not rate, so concurrency does not consume any more of it.
 */
const SEND_CONCURRENCY = 8;
const SEND_MAX_PER_SECOND = 20;

/** Default cadence for the caller's liveness callback. */
const HEARTBEAT_INTERVAL_MS = 30_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Evenly meters the START of each send to at most `perSecond`.
 *
 * Reserving a slot up front, rather than sleeping after every Nth send,
 * keeps the outgoing rate steady even when Meta's responses come back at
 * wildly different speeds: a slow response overlaps the next send
 * instead of stalling the queue behind it. Returns a no-op gate for a
 * non-positive rate, which is how tests run unmetered.
 */
function createRateGate(perSecond: number): () => Promise<void> {
  if (!Number.isFinite(perSecond) || perSecond <= 0) {
    return () => Promise.resolve();
  }
  const minIntervalMs = 1000 / perSecond;
  let nextSlot = 0;
  return async () => {
    const now = Date.now();
    const slot = Math.max(now, nextSlot);
    nextSlot = slot + minIntervalMs;
    const wait = slot - now;
    if (wait > 0) await sleep(wait);
  };
}

/**
 * Validate + persist a broadcast, resolving each recipient to a
 * contact. Returns a plan for {@link deliverBroadcast}. Throws
 * {@link BroadcastError} on bad input / missing config / a malformed
 * template / a DB failure — nothing is sent in this phase.
 */
export async function createBroadcast(
  db: SupabaseClient,
  accountId: string,
  auditUserId: string,
  params: CreateBroadcastParams
): Promise<BroadcastPlan> {
  const { name, templateName, recipients } = params;

  if (!templateName) {
    throw new BroadcastError('bad_request', "'template_name' is required", 400);
  }
  if (!Array.isArray(recipients) || recipients.length === 0) {
    throw new BroadcastError(
      'bad_request',
      "'recipients' must be a non-empty array of { to, params? }",
      400
    );
  }
  if (recipients.length > MAX_RECIPIENTS) {
    throw new BroadcastError(
      'bad_request',
      `A broadcast is capped at ${MAX_RECIPIENTS.toLocaleString()} recipients per request; split larger sends`,
      400
    );
  }

  // Config (fail fast + provides the audit trail owner already resolved
  // by the caller). Meta send needs phone_number_id + decrypted token.
  const { data: config, error: configError } = await db
    .from('whatsapp_config')
    .select('*')
    .eq('account_id', accountId)
    .single();
  if (configError || !config) {
    throw new BroadcastError(
      'whatsapp_not_configured',
      'WhatsApp not configured. Please set up your WhatsApp integration first.',
      400
    );
  }
  const accessToken = decrypt(config.access_token);

  // Template row (once) for header/button components; guard a
  // malformed local row rather than N identical opaque failures.
  const resolvedTemplate = await resolveTemplateRow(
    db,
    accountId,
    templateName,
    params.templateLanguage
  );
  if (resolvedTemplate.malformed) {
    throw new BroadcastError(
      'template_malformed',
      'Template row is malformed locally — run "Sync from Meta" in Settings to repair it before broadcasting.',
      500
    );
  }
  const templateRow = resolvedTemplate.row;

  // Resolve each recipient to a contact. Invalid phones are dropped
  // (counted as rejected) rather than aborting the whole broadcast.
  const resolved: { contactId: string; phone: string; params: string[] }[] = [];
  let rejected = 0;
  for (const r of recipients) {
    const sanitized = sanitizePhoneForMeta(typeof r.to === 'string' ? r.to : '');
    if (!isValidE164(sanitized)) {
      rejected++;
      continue;
    }
    const { id } = await findOrCreateContact(db, accountId, auditUserId, {
      phone: sanitized,
    });
    resolved.push({
      contactId: id,
      phone: sanitized,
      params: Array.isArray(r.params)
        ? r.params.filter((p): p is string => typeof p === 'string')
        : [],
    });
  }

  // Collapse recipients that resolved to the SAME contact (the caller
  // listed a phone twice, or two numbers fuzzy-matched to one contact).
  // Keep the first occurrence so the contact is messaged once and its
  // params aren't silently overwritten by a later duplicate — and so
  // the row↔params pairing below (keyed by contact_id) is unambiguous.
  const seenContact = new Set<string>();
  const deduped = resolved.filter((r) => {
    if (seenContact.has(r.contactId)) return false;
    seenContact.add(r.contactId);
    return true;
  });

  if (deduped.length === 0) {
    throw new BroadcastError(
      'bad_request',
      'No recipients had a valid E.164 phone number',
      400
    );
  }

  // Persist the broadcast + its recipients. The count columns
  // (sent/delivered/read/replied/failed) are owned by the DB aggregate
  // trigger (migrations 003/005) and derived purely from
  // broadcast_recipients rows — we deliberately do NOT seed them here
  // (a manual value would be clobbered by the trigger on the first
  // recipient change). `rejected` phones have no recipient row, so they
  // are reported to the caller in the POST response, not in these
  // persisted counts.
  // Insert the parent broadcast and its recipient rows in ONE transaction
  // (migration 037's create_broadcast_with_recipients). Previously these
  // were two separate inserts: if the recipient insert failed, the parent
  // was already persisted with status 'sending' and no recipients, leaving
  // an orphaned campaign that looked like it was sending but had no
  // delivery plan (issue #370). The function body is atomic, so a recipient
  // failure now rolls the parent back and nothing orphaned survives.
  const { data: createdRows, error: createErr } = await db.rpc(
    'create_broadcast_with_recipients',
    {
      p_account_id: accountId,
      p_user_id: auditUserId,
      p_name: name || `API broadcast (${templateName})`,
      p_template_name: templateName,
      p_template_language: resolvedTemplate.language,
      p_total_recipients: deduped.length,
      p_contact_ids: deduped.map((r) => r.contactId),
      // Frozen per-recipient params (migration 038) — without them a
      // resume of this broadcast has no way to reconstruct {{1}}.
      p_template_params: deduped.map((r) => r.params),
    }
  );
  if (createErr || !createdRows || createdRows.length === 0) {
    console.error('[broadcast-core] create broadcast error:', createErr);
    throw new BroadcastError('internal', 'Failed to create broadcast', 500);
  }

  const broadcastId = createdRows[0].broadcast_id as string;

  // Pair each inserted recipient row back to its phone/params by
  // contact_id — unambiguous now that duplicates are collapsed.
  const byContact = new Map(deduped.map((r) => [r.contactId, r]));
  const planned: PlannedRecipient[] = createdRows.map(
    (row: { recipient_id: string; contact_id: string }) => {
      const r = byContact.get(row.contact_id)!;
      return { recipientRowId: row.recipient_id, phone: r.phone, params: r.params };
    }
  );

  return {
    broadcastId,
    templateName,
    templateLanguage: resolvedTemplate.language,
    phoneNumberId: config.phone_number_id,
    accessToken,
    templateRow,
    planned,
    rejected,
  };
}

type VariantSendOutcome =
  | { ok: true; messageId: string }
  | { ok: false; error: string };

/**
 * Send one phone variant, replaying ONLY on a Meta rate-limit error
 * (429 / #130429 / #131056). A rate limit means Meta rejected the
 * request before sending, so a replay cannot double-message — the same
 * contract as the browser fan-out's 429 retry (see broadcast-retry).
 * Any other error returns immediately so the caller can record it or
 * try the next phone variant.
 */
async function sendVariantWithRateLimitRetry(
  plan: BroadcastPlan,
  to: string,
  params: string[]
): Promise<VariantSendOutcome> {
  let lastError = 'Unknown error';
  for (let attempt = 1; attempt <= BATCH_SEND_ATTEMPTS; attempt++) {
    try {
      const result = await sendTemplateMessage({
        phoneNumberId: plan.phoneNumberId,
        accessToken: plan.accessToken,
        to,
        templateName: plan.templateName,
        language: plan.templateLanguage,
        template: plan.templateRow ?? undefined,
        params,
      });
      return { ok: true, messageId: result.messageId };
    } catch (error) {
      lastError = error instanceof Error ? error.message : 'Unknown error';
      if (!isRateLimitError(lastError)) break;
      // sendTemplateMessage discards the HTTP status, so there's no
      // Retry-After to read; batchRetryDelayMs(429, null) yields the
      // module's default back-off.
      const delay =
        attempt < BATCH_SEND_ATTEMPTS ? batchRetryDelayMs(429, null) : null;
      if (delay === null) break;
      await sleep(delay);
    }
  }
  return { ok: false, error: lastError };
}

export interface DeliverBroadcastOptions {
  /** Sends kept in flight at once. Defaults to SEND_CONCURRENCY. */
  concurrency?: number;
  /**
   * Ceiling on how many sends may START per second, to stay under
   * Meta's per-number throughput. Defaults to SEND_MAX_PER_SECOND;
   * pass 0 in tests to run unmetered.
   */
  maxPerSecond?: number;
  /**
   * Called periodically for as long as the pass runs, so the caller can
   * prove its delivery lock is still alive (see
   * `touchBroadcastDelivery`). Failures are swallowed — a lost keepalive
   * write must not abort a send in progress.
   */
  onHeartbeat?: () => Promise<void>;
  /** Cadence for `onHeartbeat`. Defaults to HEARTBEAT_INTERVAL_MS. */
  heartbeatIntervalMs?: number;
}

/**
 * Send one recipient's template and stamp its `broadcast_recipients`
 * row. Resolves either way: a failure is recorded on the row, never
 * thrown, so one bad number cannot take down the rest of the pass.
 */
async function deliverOne(
  db: SupabaseClient,
  plan: BroadcastPlan,
  recipient: PlannedRecipient
): Promise<void> {
  const variants = phoneVariants(recipient.phone);
  let sentMessageId: string | null = null;
  let lastError: string | null = null;

  for (const variant of variants) {
    const outcome = await sendVariantWithRateLimitRetry(
      plan,
      variant,
      recipient.params
    );
    if (outcome.ok) {
      sentMessageId = outcome.messageId;
      lastError = null;
      break;
    }
    lastError = outcome.error;
    // Only a "recipient not allowed" error is worth another variant; a
    // rate-limit (already retried) or any other error is not.
    if (!isRecipientNotAllowedError(outcome.error)) break;
  }

  if (sentMessageId) {
    await db
      .from('broadcast_recipients')
      .update({
        status: 'sent',
        sent_at: new Date().toISOString(),
        whatsapp_message_id: sentMessageId,
        error_message: null,
      })
      .eq('id', recipient.recipientRowId);
  } else {
    await db
      .from('broadcast_recipients')
      .update({
        status: 'failed',
        error_message: lastError || 'Unknown error',
      })
      .eq('id', recipient.recipientRowId);
  }
}

/**
 * Fan out a {@link BroadcastPlan}: send each recipient's template
 * (phone-variant retry + rate-limit back-off) and stamp its
 * `broadcast_recipients` row. Best-effort per recipient — one failure
 * never aborts the rest. Designed to run inside `after()`.
 *
 * Runs a small pool of workers over a shared cursor, with a rate gate on
 * the start of each send (see {@link createRateGate}). The previous
 * strictly-sequential loop meant one slow Meta call held up every
 * remaining recipient, and one *hung* call froze the campaign outright:
 * the sent count stopped dead, the status never finalized, and the
 * caller's `finally` — hence its lock release — was never reached,
 * because the promise never settled. A pool bounds the blast radius of a
 * slow response, and `sendTemplateMessage`'s request timeout bounds it
 * in time.
 *
 * The per-status count columns on `broadcasts` are owned by the DB
 * aggregate trigger (migrations 003/005): each recipient-row update
 * below advances them automatically, and later Meta delivery/read
 * webhooks keep advancing them. We therefore never write those columns
 * here — only the terminal `status` — otherwise a manual value would
 * race and clobber the trigger-maintained counts.
 */
export async function deliverBroadcast(
  db: SupabaseClient,
  plan: BroadcastPlan,
  options: DeliverBroadcastOptions = {}
): Promise<void> {
  const concurrency = Math.max(1, options.concurrency ?? SEND_CONCURRENCY);
  const gate = createRateGate(options.maxPerSecond ?? SEND_MAX_PER_SECOND);

  // Heartbeat on a timer rather than from inside the send loop: a pass
  // whose workers are all parked on a slow Meta call is still very much
  // alive, and must not have its lock judged abandoned.
  const heartbeat = options.onHeartbeat;
  const heartbeatTimer = heartbeat
    ? setInterval(
        () => void heartbeat().catch(() => {}),
        options.heartbeatIntervalMs ?? HEARTBEAT_INTERVAL_MS
      )
    : null;
  // Never let the keepalive alone hold the Node process open.
  heartbeatTimer?.unref?.();

  try {
    // Shared cursor. `cursor++` has no await between its read and write,
    // so each worker claims a distinct index — no recipient is sent
    // twice, and none is skipped.
    let cursor = 0;
    const workerCount = Math.min(concurrency, plan.planned.length);
    await Promise.all(
      Array.from({ length: workerCount }, async () => {
        for (;;) {
          const i = cursor++;
          if (i >= plan.planned.length) return;
          await gate();
          // deliverOne records its own failures; this guard is for the
          // unexpected (a DB client throw), which must not kill the
          // worker and strand every recipient it had left to send.
          await deliverOne(db, plan, plan.planned[i]).catch((err) => {
            console.error(
              '[broadcast-core] recipient delivery threw:',
              err instanceof Error ? err.message : err
            );
          });
        }
      })
    );
  } finally {
    if (heartbeatTimer) clearInterval(heartbeatTimer);
  }

  await finalizeBroadcastStatus(db, plan.broadcastId);
}

/**
 * Flip a broadcast out of `sending` once no recipient is left pending.
 *
 * Derived from the recipient rows rather than from a counter local to
 * one delivery pass: a resume (issue #472) delivers only the leftovers,
 * so "nothing sent *this* pass" must not mark a campaign failed when
 * 800 of its 1 000 recipients went out earlier. `failed` means every
 * single recipient failed; anything else that reached Meta is `sent`,
 * with the per-recipient failures visible in `failed_count`.
 *
 * Per-status counts stay trigger-owned (migrations 003/005) — only the
 * terminal `status` is written here.
 */
export async function finalizeBroadcastStatus(
  db: SupabaseClient,
  broadcastId: string
): Promise<void> {
  const countWhere = async (status: string): Promise<number> => {
    const { count } = await db
      .from('broadcast_recipients')
      .select('id', { count: 'exact', head: true })
      .eq('broadcast_id', broadcastId)
      .eq('status', status);
    return count ?? 0;
  };

  // Still work outstanding (a capped resume pass) — leave it 'sending'
  // so the UI keeps offering Resume.
  if ((await countWhere('pending')) > 0) return;

  const failed = await countWhere('failed');
  const { count: total } = await db
    .from('broadcast_recipients')
    .select('id', { count: 'exact', head: true })
    .eq('broadcast_id', broadcastId);

  await db
    .from('broadcasts')
    .update({
      status: failed > 0 && failed === (total ?? 0) ? 'failed' : 'sent',
      updated_at: new Date().toISOString(),
    })
    .eq('id', broadcastId);
}
