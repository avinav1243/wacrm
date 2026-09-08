-- ============================================================
-- 040_message_credits.sql — per-category message credit system
--
-- Meters outbound broadcast volume against three independent,
-- per-account credit buckets that map 1:1 to message_templates.category:
--   'Marketing' | 'Utility' | 'Authentication'
--
-- Model
--
--   1. message_credits            — one balance row per (account, category).
--                                   Mutated only by the owner top-up RPC and
--                                   the send-debit trigger; never written from
--                                   the client (no INSERT/UPDATE/DELETE policy).
--   2. message_credit_transactions — append-only audit ledger. Every top-up
--                                    (+delta) and every send debit (−1) lands
--                                    one row, with the balance_after snapshot.
--   3. owner_add_credits(...)     — owner-only SECURITY DEFINER top-up RPC,
--                                   mirroring 018's authority-check contract.
--   4. broadcast_recipient_credit_debit_trigger()
--                                 — debits exactly one credit the first time a
--                                   recipient reaches status='sent'. Installed
--                                   SEPARATELY from the count trigger (005), so
--                                   the count aggregation logic is untouched.
--
-- A credit is spent per recipient that reaches 'sent' (successfully handed to
-- Meta). A recipient that fails at the send call goes pending→failed and is
-- never charged. A later Meta-side sent→failed does not refund, and a retry
-- (failed→sent) is charged exactly once — guaranteed by the partial unique
-- index on (broadcast_recipient_id) WHERE reason='sent_debit'.
--
-- Idempotent — safe to run multiple times.
-- ============================================================

-- ============================================================
-- 1. Balances — one row per (account, category).
-- ============================================================
CREATE TABLE IF NOT EXISTS message_credits (
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  category   TEXT NOT NULL CHECK (category IN ('Marketing', 'Utility', 'Authentication')),
  balance    INTEGER NOT NULL DEFAULT 0 CHECK (balance >= 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, category)
);

-- ============================================================
-- 2. Append-only ledger.
--
-- `note` is dual-purpose:
--   - manual_topup → the owner's free-text comment (may be NULL).
--   - sent_debit   → the broadcast's name, captured at debit time. Denormalized
--                    here so the debit's label survives even after the broadcast
--                    row is deleted (broadcast_id is ON DELETE SET NULL).
-- ============================================================
CREATE TABLE IF NOT EXISTS message_credit_transactions (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id             UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  category               TEXT NOT NULL CHECK (category IN ('Marketing', 'Utility', 'Authentication')),
  delta                  INTEGER NOT NULL,        -- + top-up, − send debit
  balance_after          INTEGER NOT NULL,
  reason                 TEXT NOT NULL CHECK (reason IN ('manual_topup', 'sent_debit')),
  note                   TEXT,
  broadcast_id           UUID REFERENCES broadcasts(id) ON DELETE SET NULL,
  broadcast_recipient_id UUID REFERENCES broadcast_recipients(id) ON DELETE SET NULL,
  created_by             UUID REFERENCES auth.users(id),
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Account-scoped, newest-first reads (the transactions page + owner preview).
CREATE INDEX IF NOT EXISTS idx_message_credit_transactions_account_created
  ON message_credit_transactions(account_id, created_at DESC);

-- A recipient is debited at most once, ever — even if the row re-enters 'sent'
-- (retry, webhook churn). The trigger's ON CONFLICT DO NOTHING rides this.
CREATE UNIQUE INDEX IF NOT EXISTS uq_message_credit_transactions_recipient_debit
  ON message_credit_transactions(broadcast_recipient_id)
  WHERE reason = 'sent_debit';

-- ============================================================
-- 3. Owner-only manual top-up.
--
-- Same authority contract as 018's RPCs:
--   42501 — forbidden (not owner / no account)
--   22023 — bad input (amount <= 0, unknown category)
-- ============================================================
CREATE OR REPLACE FUNCTION public.owner_add_credits(
  p_category TEXT,
  p_amount   INTEGER,
  p_note     TEXT DEFAULT NULL
) RETURNS INTEGER  -- the new balance for the category
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_account_id  UUID;
  v_role        account_role_enum;
  v_note        TEXT;
  v_new_balance INTEGER;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Unauthorized' USING ERRCODE = '42501';
  END IF;

  SELECT account_id, account_role
  INTO v_account_id, v_role
  FROM profiles
  WHERE user_id = auth.uid();

  IF v_account_id IS NULL THEN
    RAISE EXCEPTION 'Caller has no account' USING ERRCODE = '42501';
  END IF;

  IF v_role <> 'owner' THEN
    RAISE EXCEPTION 'Only the account owner can add credits'
      USING ERRCODE = '42501';
  END IF;

  IF p_category NOT IN ('Marketing', 'Utility', 'Authentication') THEN
    RAISE EXCEPTION 'Unknown credit category: %', p_category
      USING ERRCODE = '22023';
  END IF;

  IF p_amount IS NULL OR p_amount <= 0 THEN
    RAISE EXCEPTION 'Credit amount must be a positive integer'
      USING ERRCODE = '22023';
  END IF;

  v_note := NULLIF(TRIM(p_note), '');

  INSERT INTO message_credits (account_id, category, balance, updated_at)
  VALUES (v_account_id, p_category, p_amount, now())
  ON CONFLICT (account_id, category) DO UPDATE
    SET balance = message_credits.balance + EXCLUDED.balance,
        updated_at = now()
  RETURNING balance INTO v_new_balance;

  INSERT INTO message_credit_transactions (
    account_id, category, delta, balance_after, reason, note, created_by
  ) VALUES (
    v_account_id, p_category, p_amount, v_new_balance, 'manual_topup', v_note, auth.uid()
  );

  RETURN v_new_balance;
END;
$$;

ALTER FUNCTION public.owner_add_credits(TEXT, INTEGER, TEXT) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.owner_add_credits(TEXT, INTEGER, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.owner_add_credits(TEXT, INTEGER, TEXT) TO authenticated;

-- ============================================================
-- 4. Send-debit trigger.
--
-- Fires on the FIRST transition into status='sent' for a broadcast recipient.
-- Resolves the broadcast's account + template + name, maps the template to its
-- category (tolerating the en/en_US language split like resolveTemplateRow),
-- decrements that category's balance (clamped at zero), and records a
-- sent_debit ledger row with the broadcast name captured in `note`.
--
-- Installed as a separate trigger from the count aggregation (005) so the two
-- concerns stay independent.
-- ============================================================
CREATE OR REPLACE FUNCTION public.broadcast_recipient_credit_debit_trigger()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_account_id    UUID;
  v_template_name TEXT;
  v_broadcast_name TEXT;
  v_category      TEXT;
  v_new_balance   INTEGER;
BEGIN
  -- Only act on the arrival at 'sent'.
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'sent' THEN
      RETURN NEW;
    END IF;
  ELSE  -- UPDATE
    IF NOT (OLD.status IS DISTINCT FROM NEW.status AND NEW.status = 'sent') THEN
      RETURN NEW;
    END IF;
  END IF;

  SELECT b.account_id, b.template_name, b.name
  INTO v_account_id, v_template_name, v_broadcast_name
  FROM broadcasts b
  WHERE b.id = NEW.broadcast_id;

  IF v_account_id IS NULL THEN
    RETURN NEW;  -- orphaned recipient; nothing to charge.
  END IF;

  -- Resolve the template's category within the broadcast's account. Match on
  -- name; the category is language-independent so the en/en_US split doesn't
  -- matter for the lookup, but we still scope to the account to avoid
  -- cross-tenant name collisions.
  SELECT mt.category
  INTO v_category
  FROM message_templates mt
  WHERE mt.name = v_template_name
    AND mt.account_id = v_account_id
  LIMIT 1;

  -- Fall back to Utility for non-template / unresolved sends so accounting
  -- stays complete (mirrors the report's classification default).
  IF v_category IS NULL OR v_category NOT IN ('Marketing', 'Utility', 'Authentication') THEN
    v_category := 'Utility';
  END IF;

  -- Atomic decrement, clamped at zero. Returns the post-debit balance when a
  -- row exists.
  UPDATE message_credits
  SET balance = GREATEST(0, balance - 1),
      updated_at = now()
  WHERE account_id = v_account_id
    AND category = v_category
  RETURNING balance INTO v_new_balance;

  -- Record the debit even when no balance row exists yet, so the ledger is
  -- complete (balance stays clamped at zero via the row's absence).
  IF v_new_balance IS NULL THEN
    v_new_balance := 0;
  END IF;

  INSERT INTO message_credit_transactions (
    account_id, category, delta, balance_after, reason, note,
    broadcast_id, broadcast_recipient_id
  ) VALUES (
    v_account_id, v_category, -1, v_new_balance, 'sent_debit', v_broadcast_name,
    NEW.broadcast_id, NEW.id
  )
  ON CONFLICT (broadcast_recipient_id) WHERE reason = 'sent_debit' DO NOTHING;

  RETURN NEW;
END;
$$;

ALTER FUNCTION public.broadcast_recipient_credit_debit_trigger() OWNER TO postgres;

DROP TRIGGER IF EXISTS broadcast_recipient_credit_debit ON broadcast_recipients;
CREATE TRIGGER broadcast_recipient_credit_debit
  AFTER INSERT OR UPDATE ON broadcast_recipients
  FOR EACH ROW
  EXECUTE FUNCTION public.broadcast_recipient_credit_debit_trigger();

-- ============================================================
-- 5. RLS.
--
-- Members read their account's balances + ledger (the transactions page is
-- open to all members; the UI restricts the top-up action to the owner). All
-- writes go through the DEFINER RPC / trigger and the service role, so there
-- are no client INSERT/UPDATE/DELETE policies.
-- ============================================================
ALTER TABLE message_credits ENABLE ROW LEVEL SECURITY;
ALTER TABLE message_credit_transactions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS message_credits_select ON message_credits;
CREATE POLICY message_credits_select ON message_credits FOR SELECT
  USING (is_account_member(account_id));

DROP POLICY IF EXISTS message_credit_transactions_select ON message_credit_transactions;
CREATE POLICY message_credit_transactions_select ON message_credit_transactions FOR SELECT
  USING (is_account_member(account_id));
