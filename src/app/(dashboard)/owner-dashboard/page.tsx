'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { RealtimeChannel } from '@supabase/supabase-js';
import {
  CalendarRange,
  CalendarDays,
  CheckCheck,
  Crown,
  ChevronLeft,
  ChevronRight,
  Loader2,
  Megaphone,
  Send,
  ShieldCheck,
  TriangleAlert,
} from 'lucide-react';
import { useTranslations } from 'next-intl';

import { useAuth } from '@/hooks/use-auth';
import { createClient } from '@/lib/supabase/client';
import { daysAgoStart, localDayKey, startOfLocalDay } from '@/lib/dashboard/date-utils';
import {
  loadOwnerMessageReport,
  createEmptyOwnerMessageReport,
} from '@/lib/dashboard/owner-report';
import type {
  OwnerMessageReport,
  OwnerMessageStatus,
} from '@/lib/dashboard/types';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import { cn } from '@/lib/utils';

type DateRange = {
  start: string;
  end: string;
};

const STATUS_ORDER: OwnerMessageStatus[] = ['sent', 'delivered', 'failed'];

const STATUS_META: Record<
  OwnerMessageStatus,
  { labelKey: string; icon: typeof Send; tone: string }
> = {
  sent: {
    labelKey: 'sent',
    icon: Send,
    tone: 'text-sky-400',
  },
  delivered: {
    labelKey: 'delivered',
    icon: CheckCheck,
    tone: 'text-emerald-400',
  },
  failed: {
    labelKey: 'failed',
    icon: TriangleAlert,
    tone: 'text-rose-400',
  },
};

const PRESETS = [
  { labelKey: 'preset7', days: 7 },
  { labelKey: 'preset30', days: 30 },
  { labelKey: 'preset90', days: 90 },
] as const;

export default function OwnerDashboardPage() {
  const t = useTranslations('OwnerDashboard.page');
  const router = useRouter();
  const { accountRole } = useAuth();

  const [range, setRange] = useState<DateRange>(() => ({
    start: localDayKey(daysAgoStart(29)),
    end: localDayKey(startOfLocalDay()),
  }));
  const [report, setReport] = useState<OwnerMessageReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const requestIdRef = useRef(0);
  const rangeRef = useRef(range);
  const refreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const refreshReport = useCallback(
    async (currentRange: DateRange) => {
      const start = parseDateInput(currentRange.start);
      const end = parseDateInput(currentRange.end);

      if (!start || !end) {
        setError(t('invalidRange'));
        setReport(
          createEmptyOwnerMessageReport({
            start: currentRange.start,
            end: currentRange.end,
          }),
        );
        setLoading(false);
        return;
      }

      const currentRequestId = ++requestIdRef.current;
      setLoading(true);
      setError(null);

      try {
        const nextReport = await loadOwnerMessageReport(createClient(), {
          start,
          end,
        });

        if (requestIdRef.current === currentRequestId) {
          setReport(nextReport);
        }
      } catch (err) {
        if (requestIdRef.current === currentRequestId) {
          setError(err instanceof Error ? err.message : t('loadFailed'));
          setReport(null);
        }
      } finally {
        if (requestIdRef.current === currentRequestId) {
          setLoading(false);
        }
      }
    },
    [t],
  );

  useEffect(() => {
    rangeRef.current = range;
  }, [range]);

  useEffect(() => {
    if (accountRole && accountRole !== 'owner') {
      router.replace('/dashboard');
    }
  }, [accountRole, router]);

  useEffect(() => {
    if (accountRole !== 'owner') return;
    void refreshReport(range);
  }, [accountRole, range, refreshReport]);

  useEffect(() => {
    if (accountRole !== 'owner') return;

    const supabase = createClient();
    const scheduleRefresh = () => {
      if (refreshTimerRef.current) {
        clearTimeout(refreshTimerRef.current);
      }
      refreshTimerRef.current = setTimeout(() => {
        void refreshReport(rangeRef.current);
      }, 500);
    };

    const channel: RealtimeChannel = supabase
      .channel('owner-dashboard-live-report')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'broadcasts' }, scheduleRefresh)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'broadcast_recipients' }, scheduleRefresh)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'message_templates' }, scheduleRefresh)
      .subscribe();

    const interval = setInterval(scheduleRefresh, 60_000);

    return () => {
      clearInterval(interval);
      if (refreshTimerRef.current) {
        clearTimeout(refreshTimerRef.current);
        refreshTimerRef.current = null;
      }
      void supabase.removeChannel(channel);
    };
  }, [accountRole, refreshReport]);

  if (accountRole && accountRole !== 'owner') {
    return null;
  }

  if (!accountRole) {
    return (
      <div className="flex min-h-[40vh] items-center justify-center">
        <Loader2 className="size-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  const reportReady = report ?? createEmptyOwnerMessageReport({ start: range.start, end: range.end });
  const rangeLabel = formatRangeLabel(range.start, range.end);

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <div className="flex size-11 items-center justify-center rounded-xl border border-amber-500/30 bg-amber-500/10 text-amber-300">
          <Crown className="size-5" />
        </div>
        <div>
          <h1 className="text-2xl font-bold text-foreground">{t('title')}</h1>
          <p className="mt-1 text-sm text-muted-foreground">{t('description')}</p>
        </div>
      </div>

      <section className="rounded-2xl border border-border bg-card/90 p-5 shadow-sm">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
          <div className="max-w-2xl">
            <div className="flex items-center gap-2 text-sm font-semibold text-foreground">
              <CalendarRange className="size-4 text-primary" />
              {t('rangeTitle')}
            </div>
            <p className="mt-2 text-sm leading-6 text-muted-foreground">
              {t('rangeHint')}
            </p>
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <DateField
              label={t('fromLabel')}
              value={range.start}
              onChange={(value) => {
                if (!value) return;
                setRange((prev) => {
                  const nextEnd = parseDateInput(prev.end);
                  const nextStart = parseDateInput(value);
                  if (nextStart && nextEnd && nextStart > nextEnd) {
                    return { start: value, end: value };
                  }
                  return { start: value, end: prev.end };
                });
              }}
            />
            <DateField
              label={t('toLabel')}
              value={range.end}
              onChange={(value) => {
                if (!value) return;
                setRange((prev) => {
                  const nextStart = parseDateInput(prev.start);
                  const nextEnd = parseDateInput(value);
                  if (nextStart && nextEnd && nextEnd < nextStart) {
                    return { start: value, end: value };
                  }
                  return { start: prev.start, end: value };
                });
              }}
            />
          </div>
        </div>

        <div className="mt-4 flex flex-wrap items-center gap-2">
          {PRESETS.map((preset) => (
            <button
              key={preset.days}
              type="button"
              onClick={() => {
                const end = startOfLocalDay();
                const start = daysAgoStart(preset.days - 1);
                setRange({
                  start: localDayKey(start),
                  end: localDayKey(end),
                });
              }}
              className={cn(
                'rounded-full border px-3 py-1.5 text-xs font-medium transition-colors',
                range.start === localDayKey(daysAgoStart(preset.days - 1)) &&
                  range.end === localDayKey(startOfLocalDay())
                  ? 'border-primary/40 bg-primary/10 text-primary'
                  : 'border-border bg-background text-muted-foreground hover:border-primary/30 hover:text-foreground',
              )}
            >
              {t(preset.labelKey)}
            </button>
          ))}
          <p className="ml-auto text-xs text-muted-foreground">
            {t('rangeValue', { range: rangeLabel })}
          </p>
        </div>
      </section>

      {loading ? (
        <div className="grid gap-4 md:grid-cols-3">
          {Array.from({ length: 3 }).map((_, index) => (
            <div key={index} className="h-28 animate-pulse rounded-2xl border border-border bg-card/60" />
          ))}
        </div>
      ) : error ? (
        <div className="rounded-2xl border border-red-500/20 bg-red-500/5 p-5 text-sm text-red-300">
          <div className="font-semibold">{t('errorTitle')}</div>
          <p className="mt-1">{error}</p>
          <button
            type="button"
            onClick={() => {
              void refreshReport(range);
            }}
            className="mt-4 rounded-full border border-red-500/30 bg-red-500/10 px-3 py-1.5 text-xs font-medium text-red-200 transition-colors hover:bg-red-500/15"
          >
            {t('retry')}
          </button>
        </div>
      ) : (
        <>
          <div className="grid gap-4 md:grid-cols-3">
            <StatCard
              title={t('sentTotal')}
              value={reportReady.totals.sent}
              icon={Send}
              accent="text-sky-400"
              bg="bg-sky-500/10"
              border="border-sky-500/20"
            />
            <StatCard
              title={t('deliveredTotal')}
              value={reportReady.totals.delivered}
              icon={CheckCheck}
              accent="text-emerald-400"
              bg="bg-emerald-500/10"
              border="border-emerald-500/20"
            />
            <StatCard
              title={t('failedTotal')}
              value={reportReady.totals.failed}
              icon={TriangleAlert}
              accent="text-rose-400"
              bg="bg-rose-500/10"
              border="border-rose-500/20"
            />
          </div>

          <section className="rounded-2xl border border-border bg-card p-5 shadow-sm">
            <div className="flex flex-col gap-3 md:flex-row md:items-end md:justify-between">
              <div>
                <h2 className="text-sm font-semibold text-foreground">{t('breakdownTitle')}</h2>
                <p className="mt-1 text-sm text-muted-foreground">{t('breakdownHint')}</p>
              </div>
              <div className="flex flex-wrap gap-2">
                <CountPill
                  label={t('marketingLabel')}
                  value={reportReady.marketing.total}
                  icon={Megaphone}
                />
                <CountPill
                  label={t('utilityAuthLabel')}
                  value={reportReady.utilityAuthentication.total}
                  icon={ShieldCheck}
                />
              </div>
            </div>

            <div className="mt-5 overflow-hidden rounded-xl border border-border">
              <table className="w-full border-collapse text-sm">
                <thead className="bg-muted/50 text-left text-xs uppercase tracking-wide text-muted-foreground">
                  <tr>
                    <th className="px-4 py-3 font-medium">{t('statusColumn')}</th>
                    <th className="px-4 py-3 font-medium">{t('marketingColumn')}</th>
                    <th className="px-4 py-3 font-medium">{t('utilityAuthColumn')}</th>
                    <th className="px-4 py-3 font-medium">{t('totalColumn')}</th>
                  </tr>
                </thead>
                <tbody>
                  {STATUS_ORDER.map((status) => {
                    const meta = STATUS_META[status];
                    const Icon = meta.icon;
                    const rowTotal = reportReady.totals[status];
                    return (
                      <tr key={status} className="border-t border-border/70">
                        <td className="px-4 py-3">
                          <div className="flex items-center gap-2 font-medium text-foreground">
                            <Icon className={cn('size-4', meta.tone)} />
                            {t(meta.labelKey)}
                          </div>
                        </td>
                        <td className="px-4 py-3 tabular-nums text-foreground">
                          {reportReady.marketing[status].toLocaleString()}
                        </td>
                        <td className="px-4 py-3 tabular-nums text-foreground">
                          {reportReady.utilityAuthentication[status].toLocaleString()}
                        </td>
                        <td className="px-4 py-3 tabular-nums font-semibold text-foreground">
                          {rowTotal.toLocaleString()}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            <p className="mt-3 text-xs leading-5 text-muted-foreground">
              {t('classificationNote')}
            </p>
          </section>
        </>
      )}
    </div>
  );
}

function DateField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(value);
  const selected = parseDateInput(value);
  const [viewMonth, setViewMonth] = useState(
    () => startOfMonth(selected ?? new Date()),
  );

  const days = buildCalendarCells(viewMonth, selected);
  const handleOpenChange = (nextOpen: boolean) => {
    if (nextOpen) {
      setDraft(value);
      const parsed = parseDateInput(value);
      if (parsed) setViewMonth(startOfMonth(parsed));
    }
    setOpen(nextOpen);
  };

  return (
    <div className="space-y-2">
      <span className="block text-xs font-medium uppercase tracking-wide text-muted-foreground">
        {label}
      </span>
      <Popover open={open} onOpenChange={handleOpenChange}>
        <PopoverTrigger
          render={
            <Button
              variant="outline"
              className="w-full justify-between border-border bg-background px-3 py-2 text-sm font-normal text-foreground hover:bg-muted/60"
            />
          }
        >
          <span className="flex min-w-0 items-center gap-2">
            <CalendarDays className="size-4 shrink-0 text-primary" />
            <span className="truncate">
              {selected ? formatDisplayDate(selected) : 'Pick a date'}
            </span>
          </span>
          <span className="text-xs text-muted-foreground">{value}</span>
        </PopoverTrigger>
        <PopoverContent align="start" className="w-80 p-3">
          <div className="flex items-center justify-between gap-2">
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              onClick={() => setViewMonth((current) => addMonths(current, -1))}
              aria-label="Previous month"
            >
              <ChevronLeft className="size-4" />
            </Button>
            <div className="text-sm font-semibold text-popover-foreground">
              {formatMonthLabel(viewMonth)}
            </div>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              onClick={() => setViewMonth((current) => addMonths(current, 1))}
              aria-label="Next month"
            >
              <ChevronRight className="size-4" />
            </Button>
          </div>

          <div className="mt-3 grid grid-cols-7 gap-1 text-center text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
            {['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((day) => (
              <span key={day}>{day}</span>
            ))}
          </div>

          <div className="mt-2 grid grid-cols-7 gap-1">
            {days.map((cell, index) =>
              cell ? (
                <button
                  key={`${cell.date.getFullYear()}-${cell.date.getMonth()}-${cell.date.getDate()}`}
                  type="button"
                  onClick={() => {
                    onChange(localDayKey(cell.date));
                    setOpen(false);
                  }}
                  className={cn(
                    'rounded-lg px-0 py-2 text-sm transition-colors',
                    cell.selected
                      ? 'bg-primary text-primary-foreground'
                      : 'bg-background text-popover-foreground hover:bg-muted',
                  )}
                >
                  {cell.day}
                </button>
              ) : (
                <span key={`empty-${index}`} className="rounded-lg px-0 py-2" />
              ),
            )}
          </div>

          <div className="mt-3 border-t border-border pt-3">
            <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Manual entry
            </div>
            <Input
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              placeholder="YYYY-MM-DD"
              className="mt-2"
              inputMode="numeric"
            />
            <div className="mt-3 flex items-center justify-between gap-2">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => setDraft(value)}
              >
                Reset
              </Button>
              <Button
                type="button"
                size="sm"
                onClick={() => {
                  const parsed = parseDateInput(draft);
                  if (!parsed) return;
                  onChange(localDayKey(parsed));
                  setOpen(false);
                }}
              >
                Apply
              </Button>
            </div>
          </div>
        </PopoverContent>
      </Popover>
    </div>
  );
}

function StatCard({
  title,
  value,
  icon: Icon,
  accent,
  bg,
  border,
}: {
  title: string;
  value: number;
  icon: typeof Send;
  accent: string;
  bg: string;
  border: string;
}) {
  return (
    <div className={cn('rounded-2xl border bg-card p-5 shadow-sm', border)}>
      <div className="flex items-start justify-between gap-4">
        <p className="text-sm font-medium text-muted-foreground">{title}</p>
        <div className={cn('flex size-10 items-center justify-center rounded-xl', bg, accent)}>
          <Icon className="size-4" />
        </div>
      </div>
      <p className="mt-4 text-3xl font-semibold tracking-tight text-foreground tabular-nums">
        {value.toLocaleString()}
      </p>
    </div>
  );
}

function CountPill({
  label,
  value,
  icon: Icon,
}: {
  label: string;
  value: number;
  icon: typeof Megaphone;
}) {
  return (
    <div className="flex items-center gap-2 rounded-full border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
      <Icon className="size-3.5" />
      <span>{label}</span>
      <span className="font-semibold tabular-nums text-foreground">{value.toLocaleString()}</span>
    </div>
  );
}

function parseDateInput(value: string): Date | null {
  if (!value) return null;
  const [year, month, day] = value.split('-').map(Number);
  if (!year || !month || !day) return null;
  return new Date(year, month - 1, day);
}

function formatDisplayDate(date: Date): string {
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  }).format(date);
}

function formatMonthLabel(date: Date): string {
  return new Intl.DateTimeFormat(undefined, {
    month: 'long',
    year: 'numeric',
  }).format(date);
}

function startOfMonth(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), 1);
}

function addMonths(date: Date, amount: number): Date {
  return new Date(date.getFullYear(), date.getMonth() + amount, 1);
}

function buildCalendarCells(
  month: Date,
  selected: Date | null,
): Array<{
  date: Date
  day: number
  selected: boolean
} | null> {
  const year = month.getFullYear();
  const monthIndex = month.getMonth();
  const firstOfMonth = new Date(year, monthIndex, 1);
  const startPad = firstOfMonth.getDay();
  const daysInMonth = new Date(year, monthIndex + 1, 0).getDate();
  const cells: Array<{ date: Date; day: number; selected: boolean } | null> = [];
  const selectedKey = selected ? localDayKey(selected) : null;
  for (let i = 0; i < startPad; i++) cells.push(null);
  for (let day = 1; day <= daysInMonth; day++) {
    const date = new Date(year, monthIndex, day);
    cells.push({
      date,
      day,
      selected: selectedKey === localDayKey(date),
    });
  }
  while (cells.length % 7 !== 0) cells.push(null);
  return cells;
}

function formatRangeLabel(start: string, end: string): string {
  const startDate = parseDateInput(start);
  const endDate = parseDateInput(end);
  if (!startDate || !endDate) return `${start} → ${end}`;

  const formatter = new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });

  return `${formatter.format(startDate)} → ${formatter.format(endDate)}`;
}
