'use client';

import { useState } from 'react';
import { createClient } from '@/lib/supabase/client';
import { useAuth } from '@/hooks/use-auth';
import { fetchAllRows, selectInChunks } from '@/lib/supabase/fetch-all';
import {
  MAX_BROADCAST_RECIPIENTS,
  broadcastCapExceededMessage,
} from '@/lib/broadcast-limits';
import { normalizeKey } from '@/lib/contacts/dedupe';
import { Contact, MessageTemplate } from '@/types';

export type CustomFieldOperator = 'is' | 'is_not' | 'contains';

export interface CustomFieldFilter {
  fieldId: string;
  operator: CustomFieldOperator;
  value: string;
}

export interface AudienceConfig {
  type: 'all' | 'tags' | 'custom_field' | 'csv';
  tagIds?: string[];
  customField?: CustomFieldFilter;
  csvContacts?: { phone: string; name?: string }[];
  /** Contacts carrying any of these tags are subtracted from the result. */
  excludeTagIds?: string[];
}

/**
 * Variable mapping — each template placeholder (by key, usually "1",
 * "2", …) is resolved at send time. `field` maps to a built-in contact
 * field (name/phone/email/company); `custom_field` maps to a
 * contact_custom_values.value row keyed by the custom_fields.id stored
 * in `value`.
 */
export type VariableMapping =
  | { type: 'static'; value: string }
  | { type: 'field'; value: string }
  | { type: 'custom_field'; value: string };

interface BroadcastPayload {
  name: string;
  template: MessageTemplate;
  audience: AudienceConfig;
  variables: Record<string, VariableMapping>;
  /**
   * Media URL for an IMAGE/VIDEO/DOCUMENT header, collected in the
   * personalize step. Delivery now runs server-side, where the send
   * builder uses the template's stored media URL; the personalize step
   * pre-fills this field from that same stored URL. Kept for backward
   * compatibility with callers, but no longer threaded per-send.
   */
  headerMediaUrl?: string;
}

interface UseBroadcastSendingReturn {
  createAndSendBroadcast: (payload: BroadcastPayload) => Promise<string>;
  isProcessing: boolean;
  progress: number;
}

/**
 * `broadcast_recipients` inserts are chunked so each PostgREST request
 * stays small. The send itself is no longer driven from the browser:
 * once the rows are persisted 'pending', delivery is handed to the
 * server (see createAndSendBroadcast step 4), so the per-message pacing
 * that used to live here now lives in `deliverBroadcast`.
 */
const INSERT_BATCH_SIZE = 200;

/** contactId → (customFieldId → value). */
type CustomValueIndex = Map<string, Map<string, string>>;

/**
 * Per-contact resolution of custom-field placeholders. Static and
 * built-in-field mappings resolve synchronously; custom fields read
 * from a pre-built index to avoid N+1 queries during the send loop.
 */
export function resolveVariables(
  variables: Record<string, VariableMapping>,
  contact: Contact,
  customValues?: Map<string, string>,
): string[] {
  // Keys are typically "1","2",... — numeric-aware sort keeps
  // {{1}} before {{10}}.
  const keys = Object.keys(variables).sort((a, b) => {
    const an = Number(a);
    const bn = Number(b);
    if (Number.isFinite(an) && Number.isFinite(bn)) return an - bn;
    return a.localeCompare(b);
  });

  return keys.map((key) => {
    const v = variables[key];
    if (v.type === 'static') return v.value;

    if (v.type === 'field') {
      const fieldMap: Record<string, string | undefined> = {
        name: contact.name,
        phone: contact.phone,
        email: contact.email,
        company: contact.company,
      };
      return fieldMap[v.value] ?? '';
    }

    // custom_field
    return customValues?.get(v.value) ?? '';
  });
}

/**
 * Bulk-fetch contact_custom_values for a set of contacts. Returns an
 * index keyed by contact_id → field_id → value.
 */
async function fetchCustomValueIndex(
  supabase: ReturnType<typeof createClient>,
  contactIds: string[],
): Promise<CustomValueIndex> {
  const index: CustomValueIndex = new Map();
  if (contactIds.length === 0) return index;

  // Chunk the contact_id list (URL-length safe) AND page each chunk: a
  // chunk of 500 contacts with several custom fields each can exceed
  // PostgREST's 1,000-row cap, which would silently drop values and
  // produce a wrong/empty {{N}} for some recipients.
  const CHUNK = 500;
  for (let i = 0; i < contactIds.length; i += CHUNK) {
    const slice = contactIds.slice(i, i + CHUNK);
    const { data, error } = await fetchAllRows<{
      contact_id: string;
      custom_field_id: string;
      value: string | null;
    }>((from, to) =>
      supabase
        .from('contact_custom_values')
        .select('contact_id, custom_field_id, value')
        .in('contact_id', slice)
        .range(from, to),
    );
    if (error)
      throw new Error(`Failed to fetch custom values: ${error.message}`);

    for (const row of data ?? []) {
      const bucket = index.get(row.contact_id) ?? new Map<string, string>();
      bucket.set(row.custom_field_id, row.value ?? '');
      index.set(row.contact_id, bucket);
    }
  }
  return index;
}

export function useBroadcastSending(): UseBroadcastSendingReturn {
  const { accountId } = useAuth();
  const [isProcessing, setIsProcessing] = useState(false);
  const [progress, setProgress] = useState(0);

  async function resolveAudience(audience: AudienceConfig): Promise<Contact[]> {
    const supabase = createClient();

    let contacts: Contact[] = [];

    if (audience.type === 'all') {
      // Page past PostgREST's 1,000-row cap — an unbounded select here
      // is exactly what truncated a 1,978-contact broadcast to 1,000.
      const { data, error } = await fetchAllRows<Contact>((from, to) =>
        supabase.from('contacts').select('*').range(from, to),
      );
      if (error) throw new Error(`Failed to fetch contacts: ${error.message}`);
      contacts = data ?? [];
    } else if (
      audience.type === 'tags' &&
      audience.tagIds &&
      audience.tagIds.length > 0
    ) {
      // A tag can map to more than 1,000 contacts, so page the join
      // rows; the tagIds list itself is small enough for a single .in().
      const { data: contactTags, error: tagError } = await fetchAllRows<{
        contact_id: string;
      }>((from, to) =>
        supabase
          .from('contact_tags')
          .select('contact_id')
          .in('tag_id', audience.tagIds!)
          .range(from, to),
      );

      if (tagError)
        throw new Error(`Failed to fetch contact tags: ${tagError.message}`);

      if (contactTags && contactTags.length > 0) {
        const uniqueContactIds = [
          ...new Set(contactTags.map((ct) => ct.contact_id)),
        ];
        // id is unique, so chunk the (possibly >1,000) id list.
        const { data, error } = await selectInChunks<Contact>(
          (chunk) => supabase.from('contacts').select('*').in('id', chunk),
          uniqueContactIds,
        );
        if (error) throw new Error(`Failed to fetch contacts: ${error.message}`);
        contacts = data ?? [];
      }
    } else if (audience.type === 'custom_field' && audience.customField) {
      contacts = await resolveCustomFieldAudience(supabase, audience.customField);
    } else if (audience.type === 'csv' && audience.csvContacts) {
      contacts = await upsertCsvContacts(supabase, audience.csvContacts);
    }

    // Apply exclude tags (works across all contact-derived audience
    // types). CSV contacts are synthetic so exclusion doesn't apply.
    if (audience.excludeTagIds && audience.excludeTagIds.length > 0) {
      const { data: excludeRows, error: excludeError } = await fetchAllRows<{
        contact_id: string;
      }>((from, to) =>
        supabase
          .from('contact_tags')
          .select('contact_id')
          .in('tag_id', audience.excludeTagIds!)
          .range(from, to),
      );
      if (excludeError)
        throw new Error(`Failed to fetch exclude tags: ${excludeError.message}`);
      const excludedIds = new Set((excludeRows ?? []).map((r) => r.contact_id));
      contacts = contacts.filter((c) => !excludedIds.has(c.id));
    }

    return contacts;
  }

  /**
   * CSV uploads arrive as raw phone/name pairs, not DB rows. Before we
   * can insert broadcast_recipients (whose contact_id FKs contacts.id),
   * we need real contacts.id UUIDs. So: look up each CSV phone in the
   * caller's contacts table; insert any that don't exist; return the
   * resolved set.
   *
   * Pre-existing implementation synthesized `csv-N` strings as
   * contact_id, which failed the UUID cast on insert — every CSV
   * broadcast silently created zero recipients.
   *
   * Matching is on the normalized number throughout, so it agrees with
   * the account-wide unique index rather than colliding with it.
   */
  async function upsertCsvContacts(
    supabase: ReturnType<typeof createClient>,
    csvRows: { phone: string; name?: string }[],
  ): Promise<Contact[]> {
    if (csvRows.length === 0) return [];

    const {
      data: { session },
    } = await supabase.auth.getSession();
    const user = session?.user;
    if (!user) {
      throw new Error('You are not signed in.');
    }
    if (!accountId) {
      throw new Error('Your profile is not linked to an account.');
    }

    // De-duplicate within the CSV on the NORMALIZED number — the same
    // key the DB's UNIQUE (account_id, phone_normalized) index uses
    // (migration 022). Keyed on the raw string instead, "+1 555-0100"
    // and "15550100" survived as two rows and the insert below died on
    // a 23505, failing the whole broadcast.
    const uniqueByKey = new Map<string, { phone: string; name?: string }>();
    for (const row of csvRows) {
      const key = normalizeKey(row.phone);
      if (key && !uniqueByKey.has(key)) uniqueByKey.set(key, row);
    }
    const keys = [...uniqueByKey.keys()];

    // Single round-trip lookup of the contacts already in this ACCOUNT.
    // Scoping to `user_id` missed rows a teammate created on a shared
    // account, so those numbers looked new and their inserts collided
    // with the account-wide unique index.
    // phone_normalized is unique per account, so each chunk of ≤500 keys
    // returns ≤500 rows — safe to chunk and concatenate.
    const { data: existing, error: lookupErr } = await selectInChunks<Contact>(
      (chunk) =>
        supabase
          .from('contacts')
          .select('*')
          .eq('account_id', accountId)
          .in('phone_normalized', chunk),
      keys,
    );
    if (lookupErr) {
      throw new Error(`Failed to look up CSV contacts: ${lookupErr.message}`);
    }

    const byKey = new Map<string, Contact>();
    for (const c of (existing ?? []) as Contact[]) {
      const key = normalizeKey(c.phone ?? '');
      if (key) byKey.set(key, c);
    }

    // Insert only missing contacts, in one batch per 200 rows (PostgREST
    // has a default payload cap — 200 keeps individual requests small).
    const missing = keys
      .filter((k) => !byKey.has(k))
      .map((k) => uniqueByKey.get(k)!)
      .map((row) => ({
        user_id: user.id,
        account_id: accountId,
        phone: row.phone,
        name: row.name ?? null,
      }));

    const INSERT_CHUNK = 200;
    for (let i = 0; i < missing.length; i += INSERT_CHUNK) {
      const chunk = missing.slice(i, i + INSERT_CHUNK);
      const { data: inserted, error: insertErr } = await supabase
        .from('contacts')
        .insert(chunk)
        .select();
      if (insertErr) {
        throw new Error(`Failed to create CSV contacts: ${insertErr.message}`);
      }
      for (const c of (inserted ?? []) as Contact[]) {
        const key = normalizeKey(c.phone ?? '');
        if (key) byKey.set(key, c);
      }
    }

    // Preserve input order so analytics roughly matches the CSV order.
    return keys
      .map((k) => byKey.get(k))
      .filter((c): c is Contact => Boolean(c));
  }

  async function resolveCustomFieldAudience(
    supabase: ReturnType<typeof createClient>,
    filter: CustomFieldFilter,
  ): Promise<Contact[]> {
    const { fieldId, operator, value } = filter;

    // Match rows for this custom field under the chosen operator. The
    // match set can exceed 1,000, so page it — rebuilding the filtered
    // query each page (PostgREST supports eq/neq/ilike via the builder;
    // ilike with wildcards gives a case-insensitive "contains").
    const { data: matches, error: matchErr } = await fetchAllRows<{
      contact_id: string;
    }>((from, to) => {
      let query = supabase
        .from('contact_custom_values')
        .select('contact_id')
        .eq('custom_field_id', fieldId);
      if (operator === 'is') query = query.eq('value', value);
      else if (operator === 'is_not') query = query.neq('value', value);
      else if (operator === 'contains')
        query = query.ilike('value', `%${value}%`);
      return query.range(from, to);
    });
    if (matchErr)
      throw new Error(`Custom-field filter failed: ${matchErr.message}`);

    const contactIds = [...new Set((matches ?? []).map((m) => m.contact_id))];
    if (contactIds.length === 0) return [];

    const { data, error } = await selectInChunks<Contact>(
      (chunk) => supabase.from('contacts').select('*').in('id', chunk),
      contactIds,
    );
    if (error) throw new Error(`Failed to fetch contacts: ${error.message}`);
    return data ?? [];
  }

  async function createAndSendBroadcast(payload: BroadcastPayload): Promise<string> {
    setIsProcessing(true);
    setProgress(0);

    const supabase = createClient();

    try {
      // ── Step 0: Resolve current user ──────────────────────────────
      // broadcasts.user_id is NOT NULL + guarded by RLS
      // (auth.uid() = user_id). Without this, the INSERT below was
      // silently failing with 23502 / 42501 — the wizard would
      // no-op with no feedback.
      const {
        data: { session },
      } = await supabase.auth.getSession();
      const user = session?.user;
      if (!user) {
        throw new Error('You are not signed in.');
      }
      if (!accountId) {
        throw new Error('Your profile is not linked to an account.');
      }

      // ── Step 1: Resolve audience contacts ─────────────────────────
      setProgress(5);
      const contacts = await resolveAudience(payload.audience);

      if (contacts.length === 0) {
        throw new Error('No contacts found for this audience.');
      }

      // Hard cap — never truncate. Silently sending to only the first N
      // (PostgREST's old 1,000-row cut-off) is the exact bug we're
      // fixing; refuse loudly so the user narrows or splits the send.
      if (contacts.length > MAX_BROADCAST_RECIPIENTS) {
        throw new Error(broadcastCapExceededMessage(contacts.length));
      }

      // ── Step 1.5: Resolve per-recipient params ────────────────────
      // Done BEFORE the broadcast row exists so a custom-values failure
      // can't leave an orphaned 'sending' broadcast with no recipients.
      // These frozen params are also what makes the send resumable: the
      // server delivery loop reads them straight off the recipient rows.
      setProgress(15);
      const customValueIndex = await fetchCustomValueIndex(
        supabase,
        contacts.map((c) => c.id),
      );
      const paramsByContact = new Map(
        contacts.map((contact) => [
          contact.id,
          resolveVariables(
            payload.variables,
            contact,
            customValueIndex.get(contact.id),
          ),
        ]),
      );

      // ── Step 2: Create broadcast row ──────────────────────────────
      setProgress(20);
      const { data: broadcast, error: broadcastError } = await supabase
        .from('broadcasts')
        .insert({
          user_id: user.id,
          account_id: accountId,
          name: payload.name,
          template_name: payload.template.name,
          template_language: payload.template.language ?? 'en_US',
          template_variables: payload.variables,
          audience_filter: {
            type: payload.audience.type,
            tagIds: payload.audience.tagIds,
            customField: payload.audience.customField,
            excludeTagIds: payload.audience.excludeTagIds,
          },
          status: 'sending',
          total_recipients: contacts.length,
          sent_count: 0,
          delivered_count: 0,
          read_count: 0,
          replied_count: 0,
          failed_count: 0,
        })
        .select()
        .single();

      if (broadcastError || !broadcast) {
        throw new Error(
          `Failed to create broadcast: ${broadcastError?.message ?? 'unknown error'}`,
        );
      }

      // ── Step 3: Insert recipient rows (all 'pending') ─────────────
      // Each row carries its frozen template_params, so the server-side
      // delivery loop sends exactly what this pass resolved.
      const recipientRows = contacts.map((contact) => ({
        broadcast_id: broadcast.id,
        contact_id: contact.id,
        status: 'pending' as const,
        template_params: paramsByContact.get(contact.id) ?? [],
      }));

      for (let i = 0; i < recipientRows.length; i += INSERT_BATCH_SIZE) {
        const batch = recipientRows.slice(i, i + INSERT_BATCH_SIZE);
        const { error: recipientError } = await supabase
          .from('broadcast_recipients')
          .insert(batch);
        if (recipientError) {
          // Previous impl logged and marched on — the broadcast then ran
          // with an incomplete recipient set, so webhook status updates
          // couldn't find some rows and the aggregate counts drifted.
          // Flip the broadcast to failed so the user sees the problem
          // immediately, then throw to abort.
          await supabase
            .from('broadcasts')
            .update({
              status: 'failed',
              failed_count: contacts.length,
            })
            .eq('id', broadcast.id);
          throw new Error(
            `Failed to insert recipient batch ${i / INSERT_BATCH_SIZE + 1}: ${recipientError.message}`,
          );
        }
        // Rows persisted: advance 20 → 85 across the insert.
        setProgress(
          20 + Math.round(((i + batch.length) / recipientRows.length) * 65),
        );
      }

      // ── Step 4: Hand delivery to the server ───────────────────────
      // Every recipient row is now persisted 'pending' with frozen
      // params. POST to the resume endpoint: it claims the per-broadcast
      // delivery lock and fans out to Meta inside after() — server-side —
      // so the user can close this tab and the send keeps running. This
      // is the same machinery that recovers an abandoned send, so a
      // mid-send server restart is finished by clicking Resume.
      //
      // Media-header templates use the template's stored media URL on the
      // server (the personalize step pre-fills that same URL), so no
      // per-send media override is threaded here.
      setProgress(90);
      const resumeRes = await fetch(
        `/api/whatsapp/broadcast/${broadcast.id}/resume`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ scope: 'pending' }),
        },
      );
      if (!resumeRes.ok) {
        const body = await resumeRes.json().catch(() => ({}));
        throw new Error(
          body.error ||
            'Broadcast was created but delivery could not start. Open it and click Resume.',
        );
      }

      setProgress(100);
      return broadcast.id;
    } finally {
      setIsProcessing(false);
    }
  }

  return { createAndSendBroadcast, isProcessing, progress };
}
