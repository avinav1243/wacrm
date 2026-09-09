import { describe, it, expect } from 'vitest';
import {
  MAX_BROADCAST_RECIPIENTS,
  broadcastCapExceededMessage,
} from './broadcast-limits';

describe('broadcast limits', () => {
  it('caps a single broadcast at 10,000 recipients', () => {
    // Matches the account's Meta 24-hour messaging tier. If the tier
    // changes, change it here (the wizard, resume path and API all read
    // this one constant).
    expect(MAX_BROADCAST_RECIPIENTS).toBe(10_000);
  });

  it('names both the audience size and the cap in the exceeded message', () => {
    const msg = broadcastCapExceededMessage(12_345);
    // The user needs to see how far over they are and what the ceiling
    // is, both thousands-formatted.
    expect(msg).toContain('12,345');
    expect(msg).toContain('10,000');
  });
});
