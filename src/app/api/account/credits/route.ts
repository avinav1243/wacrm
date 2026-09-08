// ============================================================
// POST /api/account/credits — owner tops up a credit bucket
//
// Owner only. Adds `amount` credits to one of the three category
// buckets (Marketing / Utility / Authentication) for the caller's
// account, with an optional free-text note recorded on the ledger.
//
// The balance mutation + ledger insert are atomic in the
// `owner_add_credits` SECURITY DEFINER RPC (migration 040). This route
// validates shape, rate-limits, and forwards.
//
// Body: { category: string, amount: number, note?: string }
// ============================================================

import { NextResponse } from "next/server";
import type { PostgrestError } from "@supabase/supabase-js";

import { requireRole, toErrorResponse } from "@/lib/auth/account";
import { isCreditCategory } from "@/lib/credits/credits";
import {
  checkRateLimit,
  rateLimitResponse,
  RATE_LIMITS,
} from "@/lib/rate-limit";

/** Cap the note so the ledger column stays a comment, not a payload. */
const MAX_NOTE_LENGTH = 500;

function rpcErrorToResponse(err: PostgrestError): NextResponse {
  if (err.code === "42501") {
    return NextResponse.json({ error: err.message }, { status: 403 });
  }
  if (err.code === "22023") {
    return NextResponse.json({ error: err.message }, { status: 400 });
  }
  console.error("[credits] unexpected RPC error:", err);
  return NextResponse.json(
    { error: "Failed to add credits" },
    { status: 500 },
  );
}

export async function POST(request: Request) {
  try {
    // Fail fast on non-owners; the RPC re-checks this DB-side.
    const ctx = await requireRole("owner");

    const limit = checkRateLimit(
      `admin:addCredits:${ctx.userId}`,
      RATE_LIMITS.adminAction,
    );
    if (!limit.success) return rateLimitResponse(limit);

    const body = (await request.json().catch(() => null)) as
      | { category?: unknown; amount?: unknown; note?: unknown }
      | null;

    const category = body?.category;
    if (!isCreditCategory(typeof category === "string" ? category : "")) {
      return NextResponse.json(
        {
          error:
            "'category' must be one of Marketing, Utility, Authentication",
        },
        { status: 400 },
      );
    }

    const amount = body?.amount;
    if (
      typeof amount !== "number" ||
      !Number.isInteger(amount) ||
      amount <= 0
    ) {
      return NextResponse.json(
        { error: "'amount' must be a positive integer" },
        { status: 400 },
      );
    }

    // Optional note. Trim and cap; forward null when blank so the RPC
    // stores NULL rather than an empty string.
    let note: string | null = null;
    if (body?.note != null) {
      if (typeof body.note !== "string") {
        return NextResponse.json(
          { error: "'note' must be a string" },
          { status: 400 },
        );
      }
      const trimmed = body.note.trim();
      if (trimmed.length > MAX_NOTE_LENGTH) {
        return NextResponse.json(
          { error: `'note' must be at most ${MAX_NOTE_LENGTH} characters` },
          { status: 400 },
        );
      }
      note = trimmed.length > 0 ? trimmed : null;
    }

    const { data, error } = await ctx.supabase.rpc("owner_add_credits", {
      p_category: category,
      p_amount: amount,
      p_note: note,
    });

    if (error) return rpcErrorToResponse(error);

    return NextResponse.json({ ok: true, balance: data as number });
  } catch (err) {
    return toErrorResponse(err);
  }
}
