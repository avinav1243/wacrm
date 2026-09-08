/**
 * Hard cap on recipients per single broadcast send.
 *
 * Matches the account's Meta 24-hour messaging tier (10,000). Lives in
 * its own tiny module — deliberately NOT in broadcast-core.ts — because
 * the client wizard hook (use-broadcast-sending.ts) imports it, and
 * broadcast-core.ts pulls in server-only dependencies (encryption,
 * template resolution) that must never reach the browser bundle.
 *
 * The cap is ENFORCED, never truncated: an audience larger than this is
 * rejected with a clear message so the user can narrow or split the
 * send, rather than silently dropping the overflow — the exact failure
 * that made a 1,978-contact broadcast quietly send to only 1,000.
 */
export const MAX_BROADCAST_RECIPIENTS = 10000;

/**
 * Message thrown/shown when an audience exceeds
 * {@link MAX_BROADCAST_RECIPIENTS}. Kept here (not inlined) so the wizard
 * hook and its unit test assert the exact same text.
 */
export function broadcastCapExceededMessage(count: number): string {
  return (
    `This audience has ${count.toLocaleString()} contacts, but a single ` +
    `broadcast is capped at ${MAX_BROADCAST_RECIPIENTS.toLocaleString()} recipients. ` +
    `Narrow the audience (use tags or a filter) or split it into multiple sends.`
  );
}
