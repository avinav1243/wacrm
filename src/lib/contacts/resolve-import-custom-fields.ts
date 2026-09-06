import type { SupabaseClient } from '@supabase/supabase-js';

const DEFAULT_FIELD_TYPE = 'text';

export interface ResolveImportCustomFieldsResult {
  fieldIdByKey: Map<string, string>;
  skippedNames: string[];
}

export async function resolveImportCustomFieldIds(
  supabase: SupabaseClient,
  params: {
    accountId: string;
    userId: string;
    fieldNames: string[];
    canCreateFields: boolean;
  }
): Promise<ResolveImportCustomFieldsResult> {
  const { accountId, userId, fieldNames, canCreateFields } = params;

  const uniqueNames: string[] = [];
  const seen = new Set<string>();
  for (const raw of fieldNames) {
    const name = raw.trim();
    if (!name) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    uniqueNames.push(name);
  }

  if (uniqueNames.length === 0) {
    return { fieldIdByKey: new Map(), skippedNames: [] };
  }

  const { data: existing, error: fetchError } = await supabase
    .from('custom_fields')
    .select('id, field_name')
    .eq('account_id', accountId);

  if (fetchError) throw fetchError;

  const fieldIdByKey = new Map<string, string>();
  for (const field of existing ?? []) {
    const key = field.field_name.trim().toLowerCase();
    if (!fieldIdByKey.has(key)) fieldIdByKey.set(key, field.id);
  }

  const skippedNames: string[] = [];
  const toCreate: string[] = [];

  for (const name of uniqueNames) {
    const key = name.toLowerCase();
    if (fieldIdByKey.has(key)) continue;
    if (canCreateFields) toCreate.push(name);
    else skippedNames.push(name);
  }

  if (toCreate.length > 0) {
    const { data: created, error: createError } = await supabase
      .from('custom_fields')
      .insert(
        toCreate.map((field_name) => ({
          field_name,
          field_type: DEFAULT_FIELD_TYPE,
          user_id: userId,
          account_id: accountId,
        }))
      )
      .select('id, field_name');

    if (createError) throw createError;

    for (const field of created ?? []) {
      fieldIdByKey.set(field.field_name.trim().toLowerCase(), field.id);
    }
  }

  return { fieldIdByKey, skippedNames };
}

export interface ContactCustomFieldAssignment {
  contactId: string;
  customFields: Record<string, string>;
}

export async function assignImportedContactCustomFields(
  supabase: SupabaseClient,
  assignments: ContactCustomFieldAssignment[],
  fieldIdByKey: Map<string, string>
): Promise<number> {
  const rows: { contact_id: string; custom_field_id: string; value: string }[] = [];

  for (const { contactId, customFields } of assignments) {
    for (const [name, value] of Object.entries(customFields)) {
      const fieldId = fieldIdByKey.get(name.trim().toLowerCase());
      if (!fieldId) continue;
      rows.push({ contact_id: contactId, custom_field_id: fieldId, value });
    }
  }

  if (rows.length === 0) return 0;

  const chunkSize = 100;
  let assigned = 0;

  for (let i = 0; i < rows.length; i += chunkSize) {
    const chunk = rows.slice(i, i + chunkSize);
    const { error } = await supabase.from('contact_custom_values').upsert(chunk, {
      onConflict: 'contact_id,custom_field_id',
      ignoreDuplicates: false,
    });
    if (error) throw error;
    assigned += chunk.length;
  }

  return assigned;
}
