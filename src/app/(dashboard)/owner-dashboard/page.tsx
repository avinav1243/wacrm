'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { Crown } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useAuth } from '@/hooks/use-auth';

export default function OwnerDashboardPage() {
  const t = useTranslations('OwnerDashboard.page');
  const router = useRouter();
  const { accountRole } = useAuth();

  useEffect(() => {
    if (accountRole && accountRole !== 'owner') {
      router.replace('/dashboard');
    }
  }, [accountRole, router]);

  if (accountRole && accountRole !== 'owner') {
    return null;
  }

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

      <div className="rounded-xl border border-dashed border-border bg-card/60 p-8 text-sm text-muted-foreground">
        {t('emptyState')}
      </div>
    </div>
  );
}
