import { afterEach, describe, expect, it, vi } from 'vitest';
import { META_REQUEST_TIMEOUT_MS, sendTemplateMessage } from './meta-api';

// The broadcast fan-out persists a send's rejection message verbatim into
// broadcast_recipients.error_message. Node's fetch has no default response
// timeout, so before metaFetch a hung socket blocked the await forever and
// froze the whole campaign. These tests pin that a timed-out request now
// (a) rejects rather than hanging and (b) rejects with a message that names
// Meta and the timeout, not the opaque native "signal timed out".

const SEND_ARGS = {
  phoneNumberId: 'pn-1',
  accessToken: 'tok',
  to: '15551230000',
  templateName: 'promo',
  language: 'en_US',
} as const;

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('metaFetch timeout relabelling', () => {
  it('relabels a TimeoutError from AbortSignal.timeout', async () => {
    // Exactly what undici throws when AbortSignal.timeout fires: a
    // DOMException named 'TimeoutError' (verified instanceof Error here).
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new DOMException('The operation timed out', 'TimeoutError');
      }),
    );

    await expect(sendTemplateMessage({ ...SEND_ARGS })).rejects.toThrow(
      `Meta API request timed out after ${META_REQUEST_TIMEOUT_MS}ms`,
    );
  });

  it('relabels an AbortError too', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new DOMException('The operation was aborted', 'AbortError');
      }),
    );

    await expect(sendTemplateMessage({ ...SEND_ARGS })).rejects.toThrow(
      /Meta API request timed out/,
    );
  });

  it('passes a non-abort network error through unchanged', async () => {
    // A genuine connection failure must not be disguised as a timeout —
    // the operator needs the real reason on the recipient row.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('fetch failed: ECONNREFUSED');
      }),
    );

    await expect(sendTemplateMessage({ ...SEND_ARGS })).rejects.toThrow(
      /ECONNREFUSED/,
    );
  });

  it('applies the timeout signal to the outgoing request', async () => {
    // The signal is what makes a hung socket recoverable at all; assert it
    // is actually attached rather than silently dropped.
    let sawSignal = false;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: RequestInit) => {
        sawSignal = init.signal instanceof AbortSignal;
        return new Response(
          JSON.stringify({ messages: [{ id: 'wamid.OK' }] }),
          { status: 200 },
        );
      }),
    );

    const result = await sendTemplateMessage({ ...SEND_ARGS });
    expect(result).toEqual({ messageId: 'wamid.OK' });
    expect(sawSignal).toBe(true);
  });
});
