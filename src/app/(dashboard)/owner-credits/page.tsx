'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import type { RealtimeChannel } from '@supabase/supabase-js';
import { Loader2, Megaphone, ShieldCheck, Wallet, Wrench } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';

import { useAuth } from '@/hooks/use-auth';
import { createClient } from '@/lib/supabase/client';
import { MESSAGE_CREDIT_CATEGORIES } from '@/lib/credits/credits';
import type {
  MessageCredit,
  MessageCreditCategory,
  MessageCreditTransaction,
} from '@/types';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { cn } from '@/lib/utils';

const CATEGORY_META: Record<
  MessageCreditCategory,
  { icon: typeof Megaphone; labelKey: string; tone: string; bg: string; border: string }
> = {
  Marketing: {
    icon: Megaphone,
    labelKey: 'marketing',
    tone: 'text-sky-400',
    bg: 'bg-sky-500/10',
    border: 'border-sky-500/20',
  },
  Utility: {
    icon: Wrench,
    labelKey: 'utility',
    tone: 'text-emerald-400',
    bg: 'bg-emerald-500/10',
    border: 'border-emerald-500/20',
  },
  Authentication: {
    icon: ShieldCheck,
    labelKey: 'authentication',
    tone: 'text-amber-400',
    bg: 'bg-amber-500/10',
    border: 'border-amber-500/20',
  },
};

export default function OwnerCreditsPage() {
  const t = useTranslations('OwnerCredits.manage');
  const router = useRouter();
  const { accountId, accountRole } = useAuth();

  const [balances, setBalances] = useState<Record<MessageCreditCategory, number>>({
    Marketing: 0,
    Utility: 0,
    Authentication: 0,
  });
  const [recent, setRecent] = useState<MessageCreditTransaction[]>([]);
  const [loading, setLoading] = useState(true);
  const [category, setCategory] = useState<MessageCreditCategory>('Marketing');
  const [amount, setAmount] = useState('');
  const [comment, setComment] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const refreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const load = useCallback(async () => {
    if (!accountId) return;
    const supabase = createClient();
    const [balancesRes, txRes] = await Promise.all([
      supabase
        .from('message_credits')
        .select('category, balance')
        .eq('account_id', accountId),
      supabase
        .from('message_credit_transactions')
        .select('*')
        .eq('account_id', accountId)
        .order('created_at', { ascending: false })
        .limit(10),
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
    if (!txRes.error && txRes.data) {
      setRecent(txRes.data as MessageCreditTransaction[]);
    }
    setLoading(false);
  }, [accountId]);

  useEffect(() => {
    if (accountRole && accountRole !== 'owner') {
      router.replace('/dashboard');
    }
  }, [accountRole, router]);

  useEffect(() => {
    if (accountRole !== 'owner') return;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load();
  }, [accountRole, load]);

  useEffect(() => {
    if (accountRole !== 'owner' || !accountId) return;
    const supabase = createClient();
    const scheduleRefresh = () => {
      if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current);
      refreshTimerRef.current = setTimeout(() => {
        void load();
      }, 500);
    };
    const channel: RealtimeChannel = supabase
      .channel('owner-credits-live')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'message_credits' }, scheduleRefresh)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'message_credit_transactions' }, scheduleRefresh)
      .subscribe();
    return () => {
      if (refreshTimerRef.current) {
        clearTimeout(refreshTimerRef.current);
        refreshTimerRef.current = null;
      }
      void supabase.removeChannel(channel);
    };
  }, [accountRole, accountId, load]);

  const handleSubmit = useCallback(async () => {
    const parsed = Number(amount);
    if (!Number.isInteger(parsed) || parsed <= 0) {
      toast.error(t('invalidAmount'));
      return;
    }
    setSubmitting(true);
    try {
      const res = await fetch('/api/account/credits', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          category,
          amount: parsed,
          note: comment.trim() || undefined,
        }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(body?.error ?? t('toastError'));
      }
      toast.success(t('toastSuccess', { amount: parsed.toLocaleString(), category }));
      setAmount('');
      setComment('');
      void load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('toastError'));
    } finally {
      setSubmitting(false);
    }
  }, [amount, category, comment, load, t]);

  if (accountRole && accountRole !== 'owner') return null;

  if (!accountRole) {
    return (
      <div className="flex min-h-[40vh] items-center justify-center">
        <Loader2 className="size-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <div className="flex size-11 items-center justify-center rounded-xl border border-primary/30 bg-primary/10 text-primary">
          <Wallet className="size-5" />
        </div>
        <div>
          <h1 className="text-2xl font-bold text-foreground">{t('title')}</h1>
          <p className="mt-1 text-sm text-muted-foreground">{t('description')}</p>
        </div>
      </div>

      {/* Balances */}
      <div className="grid gap-4 md:grid-cols-3">
        {MESSAGE_CREDIT_CATEGORIES.map((cat) => {
          const meta = CATEGORY_META[cat];
          const Icon = meta.icon;
          return (
            <div
              key={cat}
              className={cn('rounded-2xl border bg-card p-5 shadow-sm', meta.border)}
            >
              <div className="flex items-start justify-between gap-4">
                <p className="text-sm font-medium text-muted-foreground">{t(meta.labelKey)}</p>
                <div className={cn('flex size-10 items-center justify-center rounded-xl', meta.bg, meta.tone)}>
                  <Icon className="size-4" />
                </div>
              </div>
              <p className="mt-4 text-3xl font-semibold tracking-tight text-foreground tabular-nums">
                {loading ? '—' : balances[cat].toLocaleString()}
              </p>
              <p className="mt-1 text-xs text-muted-foreground">{t('creditsUnit')}</p>
            </div>
          );
        })}
      </div>

      {/* Top-up form */}
      <section className="rounded-2xl border border-border bg-card p-5 shadow-sm">
        <h2 className="text-sm font-semibold text-foreground">{t('topUpTitle')}</h2>
        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          <div className="space-y-1.5">
            <label className="block text-xs font-medium uppercase tracking-wide text-muted-foreground">
              {t('categoryLabel')}
            </label>
            <Select
              value={category}
              onValueChange={(v) => setCategory(v as MessageCreditCategory)}
            >
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {MESSAGE_CREDIT_CATEGORIES.map((cat) => (
                  <SelectItem key={cat} value={cat}>
                    {t(CATEGORY_META[cat].labelKey)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <label className="block text-xs font-medium uppercase tracking-wide text-muted-foreground">
              {t('amountLabel')}
            </label>
            <Input
              value={amount}
              onChange={(e) => setAmount(e.target.value.replace(/[^0-9]/g, ''))}
              placeholder={t('amountPlaceholder')}
              inputMode="numeric"
            />
          </div>
        </div>
        <div className="mt-4 space-y-1.5">
          <label className="block text-xs font-medium uppercase tracking-wide text-muted-foreground">
            {t('commentLabel')}
          </label>
          <Textarea
            value={comment}
            onChange={(e) => setComment(e.target.value)}
            placeholder={t('commentPlaceholder')}
            maxLength={500}
            rows={2}
          />
        </div>
        <div className="mt-4 flex justify-end">
          <Button onClick={handleSubmit} disabled={submitting || !amount}>
            {submitting ? <Loader2 className="size-4 animate-spin" /> : <Wallet className="size-4" />}
            {submitting ? t('submitting') : t('submit')}
          </Button>
        </div>
      </section>

      {/* Recent activity */}
      <section className="rounded-2xl border border-border bg-card p-5 shadow-sm">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold text-foreground">{t('recentActivity')}</h2>
          <Link href="/credits" className="text-xs font-medium text-primary hover:underline">
            {t('viewAll')}
          </Link>
        </div>
        <ul className="mt-3 divide-y divide-border/70">
          {recent.length === 0 ? (
            <li className="py-6 text-center text-sm text-muted-foreground">—</li>
          ) : (
            recent.map((tx) => (
              <li key={tx.id} className="flex items-center justify-between gap-3 py-2.5 text-sm">
                <div className="min-w-0">
                  <p className="truncate text-foreground">
                    {tx.reason === 'manual_topup'
                      ? (tx.note ?? t('title'))
                      : (tx.note ?? '')}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {tx.category} · {new Date(tx.created_at).toLocaleString()}
                  </p>
                </div>
                <span
                  className={cn(
                    'shrink-0 font-semibold tabular-nums',
                    tx.delta >= 0 ? 'text-emerald-400' : 'text-rose-400',
                  )}
                >
                  {tx.delta >= 0 ? '+' : ''}
                  {tx.delta.toLocaleString()}
                </span>
              </li>
            ))
          )}
        </ul>
      </section>
    </div>
  );
}
