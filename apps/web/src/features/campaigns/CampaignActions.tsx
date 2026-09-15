import type { CampaignAction, CampaignStatus, CampaignSummary } from '@cadentor/shared';
import { useState } from 'react';
import { ErrorNotice } from '../../components/Feedback';
import { Button, ConfirmPrompt } from '../../components/ui';
import { apiPost } from '../../lib/api';

/** Offered per status; the server's lifecycle rules remain the authority. */
const ACTIONS_FOR: Readonly<Record<CampaignStatus, readonly CampaignAction[]>> = {
  DRAFT: ['start'],
  ACTIVE: ['pause', 'complete'],
  PAUSED: ['resume', 'complete'],
  COMPLETED: [],
};

const LABELS: Readonly<Record<CampaignAction, string>> = {
  start: 'Start',
  pause: 'Pause',
  resume: 'Resume',
  complete: 'Complete',
};

const VARIANTS = {
  start: 'primary',
  pause: 'warning',
  resume: 'primary',
  complete: 'danger',
} as const;

export function CampaignActions({
  campaign,
  onChanged,
}: {
  campaign: { id: string; name: string; status: CampaignStatus };
  onChanged: () => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = async (action: CampaignAction) => {
    setBusy(true);
    setError(null);
    try {
      await apiPost<CampaignSummary>(`/api/v1/campaigns/${campaign.id}/${action}`);
      setConfirming(false);
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Action failed');
    } finally {
      setBusy(false);
    }
  };

  const actions = ACTIONS_FOR[campaign.status];
  return (
    <div className="flex flex-col items-end gap-1">
      {confirming ? (
        <ConfirmPrompt
          message={`Complete "${campaign.name}"? No further messages will be sent. This cannot be undone.`}
          confirmLabel="Confirm complete"
          busy={busy}
          onConfirm={() => {
            void run('complete');
          }}
          onCancel={() => {
            setConfirming(false);
          }}
        />
      ) : (
        actions.length > 0 && (
          <div className="flex gap-1.5">
            {actions.map((action) => (
              <Button
                key={action}
                variant={VARIANTS[action]}
                disabled={busy}
                label={`${LABELS[action]} ${campaign.name}`}
                onClick={() => {
                  if (action === 'complete') setConfirming(true);
                  else void run(action);
                }}
              >
                {LABELS[action]}
              </Button>
            ))}
          </div>
        )
      )}
      {error !== null && <ErrorNotice message={error} />}
    </div>
  );
}
