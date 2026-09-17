import { describe, expect, it } from 'vitest'

import { buildOwnerMessageReport } from './owner-report'

const range = {
  start: '2026-09-10T00:00:00.000Z',
  end: '2026-09-11T00:00:00.000Z',
}

describe('buildOwnerMessageReport', () => {
  it('counts total recipients for broadcasts sent in the selected date range', () => {
    const report = buildOwnerMessageReport(
      [
        {
          created_at: '2026-09-10T02:00:00.000Z',
          template_name: 'promo',
          total_recipients: 3,
          sent_count: 2,
          delivered_count: 1,
          failed_count: 1,
        },
        {
          created_at: '2026-09-10T03:00:00.000Z',
          template_name: 'otp',
          total_recipients: 2,
          sent_count: 0,
          delivered_count: 0,
          failed_count: 2,
        },
        {
          created_at: '2026-09-12T02:00:00.000Z',
          template_name: 'promo',
          total_recipients: 10,
          sent_count: 10,
          delivered_count: 10,
          failed_count: 0,
        },
      ],
      new Map([
        ['promo', 'Marketing'],
        ['otp', 'Authentication'],
      ]),
      range,
    )

    expect(report.totals.total).toBe(5)
    expect(report.totals.sent).toBe(2)
    expect(report.totals.delivered).toBe(1)
    expect(report.totals.failed).toBe(3)
    expect(report.marketing.total).toBe(3)
    expect(report.utilityAuthentication.total).toBe(2)
  })

  it('keeps later delivery updates under the original broadcast sent date', () => {
    const report = buildOwnerMessageReport(
      [
        {
          created_at: '2026-09-09T12:00:00.000Z',
          template_name: 'promo',
          total_recipients: 1,
          sent_count: 1,
          delivered_count: 1,
          failed_count: 0,
        },
      ],
      new Map([['promo', 'Marketing']]),
      range,
    )

    expect(report.totals.total).toBe(0)
    expect(report.totals.sent).toBe(0)
    expect(report.totals.delivered).toBe(0)
  })
})
