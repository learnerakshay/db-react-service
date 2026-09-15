import { CAMPAIGN_LEAD_STATUSES, IMPORT_ROW_OUTCOMES, IMPORT_ROW_REASONS } from '@cadentor/shared';
import { describe, expect, it } from 'vitest';
import {
  CampaignLeadStatus,
  ImportRowOutcome,
  ImportRowReason,
} from '../../src/generated/prisma/enums.js';
import {
  CAMPAIGN_LEAD_TRANSITIONS,
  canTransitionCampaignLead,
} from '../../src/modules/campaigns/membership.js';

describe('campaign lead transitions', () => {
  it('defines exits for every status', () => {
    expect(Object.keys(CAMPAIGN_LEAD_TRANSITIONS).sort()).toEqual(
      Object.values(CampaignLeadStatus).sort(),
    );
  });

  it('allows the forward path', () => {
    expect(canTransitionCampaignLead('STAGED', 'QUEUED')).toBe(true);
    expect(canTransitionCampaignLead('QUEUED', 'STEP_1_SENT')).toBe(true);
    expect(canTransitionCampaignLead('STEP_1_SENT', 'ENGAGED')).toBe(true);
    expect(canTransitionCampaignLead('ENGAGED', 'QUALIFIED')).toBe(true);
    expect(canTransitionCampaignLead('QUALIFIED', 'BOOKED')).toBe(true);
  });

  it('allows booking conversion only from QUALIFIED', () => {
    const intoBooked = Object.values(CampaignLeadStatus).filter((from) =>
      canTransitionCampaignLead(from, 'BOOKED'),
    );
    expect(intoBooked).toEqual(['QUALIFIED']);
  });

  it('rejects skipping steps, going backwards, and leaving terminal states', () => {
    expect(canTransitionCampaignLead('STAGED', 'STEP_1_SENT')).toBe(false);
    expect(canTransitionCampaignLead('STAGED', 'BOOKED')).toBe(false);
    expect(canTransitionCampaignLead('STEP_2_SENT', 'STEP_1_SENT')).toBe(false);
    expect(canTransitionCampaignLead('OPTED_OUT', 'QUEUED')).toBe(false);
    expect(canTransitionCampaignLead('DORMANT_ARCHIVED', 'ENGAGED')).toBe(false);
    expect(canTransitionCampaignLead('STAGED', 'STAGED')).toBe(false);
  });

  it('lets any non-terminal state opt out', () => {
    for (const status of Object.values(CampaignLeadStatus)) {
      if (status === 'OPTED_OUT' || status === 'DORMANT_ARCHIVED') continue;
      expect(canTransitionCampaignLead(status, 'OPTED_OUT')).toBe(true);
    }
  });
});

describe('shared contracts match database enums', () => {
  it('keeps enum values in sync', () => {
    expect([...CAMPAIGN_LEAD_STATUSES].sort()).toEqual(Object.values(CampaignLeadStatus).sort());
    expect([...IMPORT_ROW_OUTCOMES].sort()).toEqual(Object.values(ImportRowOutcome).sort());
    expect([...IMPORT_ROW_REASONS].sort()).toEqual(Object.values(ImportRowReason).sort());
  });
});
