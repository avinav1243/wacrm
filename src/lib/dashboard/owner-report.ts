import type { SupabaseClient } from '@supabase/supabase-js'

import type {
  OwnerMessageCategoryCounts,
  OwnerMessageReport,
  OwnerMessageStatus,
} from './types'

type DB = SupabaseClient

type BroadcastRow = {
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

/**
 * Aggregate the owner's outbound delivery report from row data.
 *
 * Marketing is only the marketing template bucket. Utility /
 * authentication also absorbs non-template operational sends so the
 * report stays complete even when the message row has no template name.
 */
export function buildOwnerMessageReport(
  messages: BroadcastRow[],
  templateCategories: Map<string, string>,
  range: OwnerMessageReport['range'],
): OwnerMessageReport {
  const report = createEmptyOwnerMessageReport(range)

  for (const row of messages) {
    const delivered = row.delivered_count ?? 0
    const failed = row.failed_count ?? 0
    const sent = delivered + failed
    if (sent === 0) continue

    addCount(report.totals, 'sent', sent)
    addCount(report.totals, 'delivered', delivered)
    addCount(report.totals, 'failed', failed)
    report.totals.total += sent

    const category = row.template_name
      ? classifyMessage(templateCategories.get(row.template_name))
      : 'utilityAuthentication'

    addCount(report[category], 'sent', sent)
    addCount(report[category], 'delivered', delivered)
    addCount(report[category], 'failed', failed)
    report[category].total += sent
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

  const [broadcastsRes, templatesRes] = await Promise.all([
    db
      .from('broadcasts')
      .select('template_name, created_at, delivered_count, failed_count')
      .gte('created_at', start)
      .lt('created_at', endExclusive.toISOString())
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
    (broadcastsRes.data ?? []) as BroadcastRow[],
    templateCategories,
    {
      start: range.start.toISOString(),
      end: endExclusive.toISOString(),
    },
  )
}
