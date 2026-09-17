import type { SupabaseClient } from '@supabase/supabase-js'

import type {
  OwnerMessageCategoryCounts,
  OwnerMessageReport,
  OwnerMessageStatus,
} from './types'

type DB = SupabaseClient

type BroadcastReportRow = {
  total_recipients: number | null
  sent_count: number | null
  delivered_count: number | null
  failed_count: number | null
  template_name: string | null
  created_at: string
}

type TemplateRow = {
  name: string
  category: 'Marketing' | 'Utility' | 'Authentication' | string
}

function createCounts(): OwnerMessageCategoryCounts {
  return {
    sent: 0,
    delivered: 0,
    failed: 0,
    total: 0,
  }
}

export function createEmptyOwnerMessageReport(
  range: OwnerMessageReport['range'],
): OwnerMessageReport {
  return {
    range,
    totals: createCounts(),
    marketing: createCounts(),
    utilityAuthentication: createCounts(),
  }
}

function addCount(
  bucket: OwnerMessageCategoryCounts,
  status: OwnerMessageStatus,
  amount = 1,
): void {
  bucket[status] += amount
}

function classifyMessage(templateCategory: string | null | undefined): 'marketing' | 'utilityAuthentication' {
  return templateCategory === 'Marketing' ? 'marketing' : 'utilityAuthentication'
}

function isInRange(iso: string | null, start: string, endExclusive: string): boolean {
  return Boolean(iso && iso >= start && iso < endExclusive)
}

/**
 * Aggregate the owner's outbound delivery report from broadcast row data.
 *
 * Marketing is only the marketing template bucket. Utility /
 * authentication also absorbs non-template operational sends so the
 * report stays complete even when the broadcast row has no template name.
 */
export function buildOwnerMessageReport(
  broadcasts: BroadcastReportRow[],
  templateCategories: Map<string, string>,
  range: OwnerMessageReport['range'],
): OwnerMessageReport {
  const report = createEmptyOwnerMessageReport(range)

  for (const row of broadcasts) {
    if (!isInRange(row.created_at, range.start, range.end)) continue

    const totalRecipients = row.total_recipients ?? 0
    const sent = row.sent_count ?? 0
    const delivered = row.delivered_count ?? 0
    const failed = row.failed_count ?? 0
    if (totalRecipients === 0) continue

    addCount(report.totals, 'sent', sent)
    addCount(report.totals, 'delivered', delivered)
    addCount(report.totals, 'failed', failed)
    report.totals.total += totalRecipients

    const category = row.template_name
      ? classifyMessage(templateCategories.get(row.template_name))
      : 'utilityAuthentication'

    addCount(report[category], 'sent', sent)
    addCount(report[category], 'delivered', delivered)
    addCount(report[category], 'failed', failed)
    report[category].total += totalRecipients
  }

  return report
}

export async function loadOwnerMessageReport(
  db: DB,
  range: { start: Date; end: Date },
): Promise<OwnerMessageReport> {
  const start = range.start.toISOString()
  const endExclusive = new Date(range.end)
  endExclusive.setDate(endExclusive.getDate() + 1)
  const end = endExclusive.toISOString()

  const [broadcastsRes, templatesRes] = await Promise.all([
    db
      .from('broadcasts')
      .select('template_name, created_at, total_recipients, sent_count, delivered_count, failed_count')
      .gte('created_at', start)
      .lt('created_at', end)
      .order('created_at', { ascending: true }),
    db.from('message_templates').select('name, category'),
  ])

  if (broadcastsRes.error) throw broadcastsRes.error
  if (templatesRes.error) throw templatesRes.error

  const templateCategories = new Map<string, string>()
  for (const template of (templatesRes.data ?? []) as TemplateRow[]) {
    if (!template.name) continue
    if (!templateCategories.has(template.name)) {
      templateCategories.set(template.name, template.category)
    }
  }

  return buildOwnerMessageReport(
    (broadcastsRes.data ?? []) as BroadcastReportRow[],
    templateCategories,
    {
      start: range.start.toISOString(),
      end,
    },
  )
}
