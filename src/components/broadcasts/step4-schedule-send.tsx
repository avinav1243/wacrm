'use client';

import { useEffect, useState } from 'react';
import { createClient } from '@/lib/supabase/client';
import { fetchAllRows } from '@/lib/supabase/fetch-all';
import { MAX_BROADCAST_RECIPIENTS } from '@/lib/broadcast-limits';
import { MessageTemplate } from '@/types';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { ArrowLeft, Send, Loader2, Users, Save } from 'lucide-react';
import { useTranslations } from 'next-intl';

interface AudienceConfig {
  type: string;
  tagIds?: string[];
  customField?: {
    fieldId: string;
    operator: 'is' | 'is_not' | 'contains';
    value: string;
  };
  csvContacts?: { phone: string; name?: string }[];
  excludeTagIds?: string[];
}

interface Step4Props {
  name: string;
  onNameChange: (name: string) => void;
  template: MessageTemplate;
  audience: AudienceConfig;
  onSend: () => void;
  onSaveDraft?: () => void;
  onBack: () => void;
  isProcessing: boolean;
  progress: number;
}

export function Step4ScheduleSend({
  name,
  onNameChange,
  template,
  audience,
  onSend,
  onSaveDraft,
  onBack,
  isProcessing,
  progress,
}: Step4Props) {
  const t = useTranslations('Broadcasts.wizard');
  const [showConfirm, setShowConfirm] = useState(false);
  const [estimatedReach, setEstimatedReach] = useState<number>(0);
  const [loadingReach, setLoadingReach] = useState(true);

  useEffect(() => {
    async function calculateReach() {
      setLoadingReach(true);
      try {
        const supabase = createClient();

        // Base id set before excludes; null means "all contacts".
        let baseIds: Set<string> | null = null;

        if (audience.type === 'all') {
          // Handled below via an exact count.
        } else if (
          audience.type === 'tags' &&
          audience.tagIds &&
          audience.tagIds.length > 0
        ) {
          // Page past PostgREST's 1,000-row cap so this final confirmation
          // matches what the send resolves — an unpaginated read capped at
          // 1,000, the mismatch behind "1,978 shown / 1,000 sent".
          const { data, error } = await fetchAllRows<{ contact_id: string }>(
            (from, to) =>
              supabase
                .from('contact_tags')
                .select('contact_id')
                .in('tag_id', audience.tagIds!)
                .range(from, to),
          );
          if (error) {
            console.error('[step4] tag reach failed:', error.message);
            setEstimatedReach(0);
            return;
          }
          baseIds = new Set((data ?? []).map((ct) => ct.contact_id));
        } else if (
          audience.type === 'custom_field' &&
          audience.customField?.fieldId &&
          audience.customField.value
        ) {
          // Previously unhandled here — a custom-field audience showed
          // "0" reach and the confirm dialog said "0 contacts".
          const { fieldId, operator, value } = audience.customField;
          const { data, error } = await fetchAllRows<{ contact_id: string }>(
            (from, to) => {
              let q = supabase
                .from('contact_custom_values')
                .select('contact_id')
                .eq('custom_field_id', fieldId);
              if (operator === 'is') q = q.eq('value', value);
              else if (operator === 'is_not') q = q.neq('value', value);
              else q = q.ilike('value', `%${value}%`);
              return q.range(from, to);
            },
          );
          if (error) {
            console.error('[step4] custom-field reach failed:', error.message);
            setEstimatedReach(0);
            return;
          }
          baseIds = new Set((data ?? []).map((m) => m.contact_id));
        } else if (audience.type === 'csv' && audience.csvContacts) {
          setEstimatedReach(audience.csvContacts.length);
          return;
        } else {
          setEstimatedReach(0);
          return;
        }

        // Exclude tags apply to every contact-derived audience.
        let excludeSet: Set<string> | null = null;
        if (audience.excludeTagIds && audience.excludeTagIds.length > 0) {
          const { data: excludeRows, error: excludeError } =
            await fetchAllRows<{ contact_id: string }>((from, to) =>
              supabase
                .from('contact_tags')
                .select('contact_id')
                .in('tag_id', audience.excludeTagIds!)
                .range(from, to),
            );
          if (excludeError) {
            console.error('[step4] exclude reach failed:', excludeError.message);
            setEstimatedReach(0);
            return;
          }
          excludeSet = new Set((excludeRows ?? []).map((r) => r.contact_id));
        }

        if (baseIds) {
          const effective = [...baseIds].filter((id) => !excludeSet?.has(id));
          setEstimatedReach(effective.length);
        } else {
          const { count } = await supabase
            .from('contacts')
            .select('*', { count: 'exact', head: true });
          const total = count ?? 0;
          setEstimatedReach(
            excludeSet ? Math.max(0, total - excludeSet.size) : total,
          );
        }
      } finally {
        setLoadingReach(false);
      }
    }

    calculateReach();
  }, [audience]);

  // The server hard-caps a send at MAX_BROADCAST_RECIPIENTS; block the
  // confirm here so the user isn't walked to the send button only to be
  // refused. The reach is computed from the actual id sets, so gating on
  // it is safe.
  const overCap = !loadingReach && estimatedReach > MAX_BROADCAST_RECIPIENTS;

  const audienceLabel =
    audience.type === 'all'
      ? t('scheduleSend.audienceAll')
      : audience.type === 'tags'
        ? t('scheduleSend.audienceTags')
        : audience.type === 'csv'
          ? t('scheduleSend.audienceCsv')
          : t('scheduleSend.audienceField');

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold text-foreground">{t('scheduleSend.title')}</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          {t('scheduleSend.subtitle')}
        </p>
      </div>

      {/* Broadcast Name */}
      <div>
        <label className="mb-1.5 block text-sm font-medium text-foreground">{t('scheduleSend.broadcastName')}</label>
        <Input
          value={name}
          onChange={(e) => onNameChange(e.target.value)}
          placeholder={t('scheduleSend.broadcastNamePlaceholder')}
          className="border-border bg-muted text-foreground placeholder:text-muted-foreground"
        />
      </div>

      {/* Summary Card */}
      <div className="rounded-xl border border-border bg-card/50 p-4 space-y-3">
        <p className="text-sm font-medium text-foreground">{t('scheduleSend.summary')}</p>
        <div className="grid grid-cols-2 gap-3 text-sm">
          <div>
            <p className="text-xs text-muted-foreground">{t('scheduleSend.template')}</p>
            <p className="text-foreground">{template.name}</p>
          </div>
          <div>
            <p className="text-xs text-muted-foreground">{t('scheduleSend.audience')}</p>
            <p className="text-foreground">{audienceLabel}</p>
          </div>
          <div>
            <p className="text-xs text-muted-foreground">Estimated Reach</p>
            <div className="flex items-center gap-1.5">
              {loadingReach ? (
                <Loader2 className="h-3 w-3 animate-spin text-primary" />
              ) : (
                <>
                  <Users className="h-3.5 w-3.5 text-primary" />
                  <p className="font-medium text-foreground">{estimatedReach.toLocaleString()}</p>
                </>
              )}
            </div>
          </div>
          <div>
            <p className="text-xs text-muted-foreground">Language</p>
            <p className="text-foreground">{template.language ?? 'en_US'}</p>
          </div>
        </div>
        {overCap && (
          <p className="text-xs text-red-400">
            This audience of {estimatedReach.toLocaleString()} exceeds the{' '}
            {MAX_BROADCAST_RECIPIENTS.toLocaleString()}-recipient limit for a
            single broadcast. Go back and narrow the audience with tags or a
            filter, or split it into multiple sends.
          </p>
        )}
      </div>

      {/* Processing overlay */}
      {isProcessing && (
        <div className="rounded-xl border border-primary/20 bg-primary/5 p-4">
          <div className="mb-2 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Loader2 className="h-4 w-4 animate-spin text-primary" />
              <p className="text-sm font-medium text-foreground">{t('scheduleSend.sending')}</p>
            </div>
            <span className="text-xs font-medium text-primary">{progress}%</span>
          </div>
          <div className="h-1.5 w-full rounded-full bg-muted">
            <div
              className="h-1.5 rounded-full bg-primary transition-all duration-300"
              style={{ width: `${progress}%` }}
            />
          </div>
        </div>
      )}

      <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border pt-4">
        <Button
          variant="outline"
          onClick={onBack}
          disabled={isProcessing}
          className="border-border text-muted-foreground"
        >
          <ArrowLeft className="h-4 w-4" />
          {t('back')}
        </Button>

        <div className="flex items-center gap-2">
          {onSaveDraft && (
            <Button
              variant="outline"
              onClick={onSaveDraft}
              disabled={!name.trim() || isProcessing}
              className="border-border text-muted-foreground hover:bg-muted disabled:opacity-50"
            >
              <Save className="h-4 w-4" />
              {t('scheduleSend.saveDraft')}
            </Button>
          )}

          <Dialog open={showConfirm} onOpenChange={setShowConfirm}>
          <DialogTrigger
            render={
              <Button
                disabled={!name.trim() || isProcessing || overCap}
                className="bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
              />
            }
          >
            <Send className="h-4 w-4" />
            {t('scheduleSend.sendNow')}
          </DialogTrigger>
          <DialogContent className="border-border bg-popover sm:max-w-md">
            <DialogHeader>
              <DialogTitle className="text-popover-foreground">Confirm Broadcast</DialogTitle>
              <DialogDescription className="text-muted-foreground">
                You are about to send this broadcast to{' '}
                <span className="font-medium text-popover-foreground">{estimatedReach.toLocaleString()}</span>{' '}
                contacts using the{' '}
                <span className="font-medium text-popover-foreground">{template.name}</span> template.
                This action cannot be undone.
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button
                variant="outline"
                onClick={() => setShowConfirm(false)}
                className="border-border text-muted-foreground"
              >
                {t('cancel')}
              </Button>
              <Button
                onClick={() => {
                  setShowConfirm(false);
                  onSend();
                }}
                className="bg-primary text-primary-foreground hover:bg-primary/90"
              >
                <Send className="h-4 w-4" />
                {t('scheduleSend.sendNow')}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
        </div>
      </div>
    </div>
  );
}
