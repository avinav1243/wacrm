import type { SupabaseClient } from "@supabase/supabase-js";

import type { MessageCreditCategory } from "@/types";

/**
 * The three credit categories, in display order. Mirrors the
 * `message_templates.category` domain 1:1 — the bucket a broadcast draws
 * from is exactly its template's category.
 */
export const MESSAGE_CREDIT_CATEGORIES: readonly MessageCreditCategory[] = [
  "Marketing",
  "Utility",
  "Authentication",
] as const;

/**
 * Pure guard for the credit-category domain. Modelled on `isAccountRole`
 * in `@/lib/auth/roles` — narrows an untrusted string (a template's
 * `category`, a query param) to `MessageCreditCategory`.
 */
export function isCreditCategory(
  value: string | null | undefined,
): value is MessageCreditCategory {
  return (
    value === "Marketing" ||
    value === "Utility" ||
    value === "Authentication"
  );
}

/**
 * Read the current balance for one (account, category) bucket.
 *
 * Returns 0 when no balance row exists yet — an account that has never
 * been topped up in a category simply has zero credits there, which is
 * indistinguishable from an explicit zero balance for gating purposes.
 * A genuine query error is thrown so callers don't silently treat a
 * failed read as "no credits".
 */
export async function fetchCategoryBalance(
  db: SupabaseClient,
  accountId: string,
  category: MessageCreditCategory,
): Promise<number> {
  const { data, error } = await db
    .from("message_credits")
    .select("balance")
    .eq("account_id", accountId)
    .eq("category", category)
    .maybeSingle();

  if (error) throw error;

  return data?.balance ?? 0;
}
