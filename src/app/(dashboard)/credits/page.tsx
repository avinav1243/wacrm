'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import type { RealtimeChannel } from '@supabase/supabase-js';
import { Loader2, Receipt } from 'lucide-react';
import { useTranslations } from 'next-intl';

import { useAuth } from '@/hooks/use-auth';
import { createClient } from '@/lib/supabase/client';
import { MESSAGE_CREDIT_CATEGORIES } from '@/lib/credits/credits';
import type {
  MessageCredit,
  MessageCreditCategory,
  MessageCreditTransaction,
} from '@/types';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { cn } from '@/lib/utils';

type TypeFilter = 'all' | 'credits' | 'debits';
type CategoryFilter = 'all' | MessageCreditCategory;

const PAGE_LIMIT = 200;

export default function CreditsPage() {
  const t = useTranslations('OwnerCredits.history');
  const { accountId } = useAuth();

  const [balances, setBalances] = useState<Record<MessageCreditCategory, number>>({
    Marketing: 0,
    Utility: 0,
    Authentication: 0,
  });
  const [transactions, setTransactions] = useState<MessageCreditTransaction[] | null>(
    null,
  );
  const [typeFilter, setTypeFilter] = useState<TypeFilter>('all');
  const [categoryFilter, setCategoryFilter] = useState<CategoryFilter>('all');
  const refreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const load = useCallback(async () => {
    if (!accountId) return;
    const supabase = createClient();

    let query = supabase
      .from('message_credit_transactions')
      .select('*')
      .eq('account_id', accountId)
      .order('created_at', { ascending: false })
      .limit(PAGE_LIMIT);

    if (typeFilter === 'credits') query = query.eq('reason', 'manual_topup');
    else if (typeFilter === 'debits') query = query.eq('reason', 'sent_debit');
    if (categoryFilter !== 'all') query = query.eq('category', categoryFilter);

    const [txRes, balancesRes] = await Promise.all([
      query,
      supabase
        .from('message_credits')
        .select('category, balance')
        .eq('account_id', accountId),
    ]);

    if (!balancesRes.error && balancesRes.data) {
      const next: Record<MessageCreditCategory, number> = {
        Marketing: 0,
        Utility: 0,
        Authentication: 0,
      };
      for (const row of balancesRes.data as Pick<MessageCredit, 'category' | 'balance'>[]) {
        next[row.category] = row.balance;
      }
      setBalances(next);
    }
    setTransactions((txRes.data ?? []) as MessageCreditTransaction[]);
  }, [accountId, typeFilter, categoryFilter]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load();
  }, [load]);

  useEffect(() => {
    if (!accountId) return;
    const supabase = createClient();
    const scheduleRefresh = () => {
      if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current);
      refreshTimerRef.current = setTimeout(() => {
        void load();
      }, 500);
    };
    const channel: RealtimeChannel = supabase
      .channel('credits-history-live')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'message_credit_transactions' }, scheduleRefresh)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'message_credits' }, scheduleRefresh)
      .subscribe();
    return () => {
      if (refreshTimerRef.current) {
        clearTimeout(refreshTimerRef.current);
        refreshTimerRef.current = null;
      }
      void supabase.removeChannel(channel);
    };
  }, [accountId, load]);

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <div className="flex size-11 items-center justify-center rounded-xl border border-primary/30 bg-primary/10 text-primary">
          <Receipt className="size-5" />
        </div>
        <div>
          <h1 className="text-2xl font-bold text-foreground">{t('title')}</h1>
          <p className="mt-1 text-sm text-muted-foreground">{t('description')}</p>
        </div>
      </div>

      {/* Balances (read-only) */}
      <div className="grid gap-4 md:grid-cols-3">
        {MESSAGE_CREDIT_CATEGORIES.map((cat) => (
          <div key={cat} className="rounded-2xl border border-border bg-card p-5 shadow-sm">
            <p className="text-sm font-medium text-muted-foreground">
              {t(cat.toLowerCase())}
            </p>
            <p className="mt-3 text-3xl font-semibold tracking-tight text-foreground tabular-nums">
              {balances[cat].toLocaleString()}
            </p>
            <p className="mt-1 text-xs text-muted-foreground">{t('creditsUnit')}</p>
          </div>
        ))}
      </div>

      {/* Filters */}
      <div className="flex flex-wrap items-end gap-3">
        <div className="space-y-1.5">
          <label className="block text-xs font-medium uppercase tracking-wide text-muted-foreground">
            {t('filterType')}
          </label>
          <Select value={typeFilter} onValueChange={(v) => setTypeFilter(v as TypeFilter)}>
            <SelectTrigger className="w-40">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">{t('filterTypeAll')}</SelectItem>
              <SelectItem value="credits">{t('filterTypeCredits')}</SelectItem>
              <SelectItem value="debits">{t('filterTypeDebits')}</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1.5">
          <label className="block text-xs font-medium uppercase tracking-wide text-muted-foreground">
            {t('filterCategory')}
          </label>
          <Select
            value={categoryFilter}
            onValueChange={(v) => setCategoryFilter(v as CategoryFilter)}
          >
            <SelectTrigger className="w-44">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">{t('filterCategoryAll')}</SelectItem>
              {MESSAGE_CREDIT_CATEGORIES.map((cat) => (
                <SelectItem key={cat} value={cat}>
                  {t(cat.toLowerCase())}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      {/* Transactions table */}
      {transactions === null ? (
        <div className="flex h-48 items-center justify-center">
          <Loader2 className="size-6 animate-spin text-primary" />
        </div>
      ) : transactions.length === 0 ? (
        <div className="flex h-40 flex-col items-center justify-center rounded-xl border border-dashed border-border bg-muted/40">
          <Receipt className="size-6 text-muted-foreground" />
          <p className="mt-3 text-sm font-medium text-foreground">{t('empty')}</p>
        </div>
      ) : (
        <div className="overflow-hidden rounded-2xl border border-border">
          <table className="w-full border-collapse text-sm">
            <thead className="bg-muted/50 text-left text-xs uppercase tracking-wide text-muted-foreground">
              <tr>
                <th className="px-4 py-3 font-medium">{t('colDate')}</th>
                <th className="px-4 py-3 font-medium">{t('colCategory')}</th>
                <th className="px-4 py-3 font-medium">{t('colType')}</th>
                <th className="px-4 py-3 font-medium text-right">{t('colAmount')}</th>
                <th className="px-4 py-3 font-medium text-right">{t('colBalance')}</th>
                <th className="px-4 py-3 font-medium">{t('colDetails')}</th>
              </tr>
            </thead>
            <tbody>
              {transactions.map((tx) => {
                const isCredit = tx.delta >= 0;
                return (
                  <tr key={tx.id} className="border-t border-border/70">
                    <td className="whitespace-nowrap px-4 py-3 text-muted-foreground">
                      {new Date(tx.created_at).toLocaleString()}
                    </td>
                    <td className="px-4 py-3 text-foreground">{t(tx.category.toLowerCase())}</td>
                    <td className="px-4 py-3">
                      <span
                        className={cn(
                          'inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium',
                          isCredit
                            ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-400'
                            : 'border-rose-500/30 bg-rose-500/10 text-rose-400',
                        )}
                      >
                        {isCredit ? t('typeCredit') : t('typeDebit')}
                      </span>
                    </td>
                    <td
                      className={cn(
                        'px-4 py-3 text-right tabular-nums font-semibold',
                        isCredit ? 'text-emerald-400' : 'text-rose-400',
                      )}
                    >
                      {isCredit ? '+' : ''}
                      {tx.delta.toLocaleString()}
                    </td>
                    <td className="px-4 py-3 text-right tabular-nums text-foreground">
                      {tx.balance_after.toLocaleString()}
                    </td>
                    <td className="px-4 py-3 text-muted-foreground">
                      {tx.reason === 'sent_debit' ? (
                        tx.broadcast_id ? (
                          <Link
                            href={`/broadcasts/${tx.broadcast_id}`}
                            className="text-primary hover:underline"
                          >
                            {tx.note ?? t('sentDebit')}
                          </Link>
                        ) : (
                          (tx.note ?? t('sentDebit'))
                        )
                      ) : (
                        (tx.note ?? t('manualTopUp'))
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
