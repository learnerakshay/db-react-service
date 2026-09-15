import type { AppConfig } from '../config/index.js';
import { ConfigurationError } from '../lib/errors.js';
import type { CrmProvider } from './crm/index.js';
import type { PostBookingHandoffProvider } from './handoff/index.js';
import type { NotificationProvider } from './notifications/index.js';

export interface IntegrationProviders {
  crm: CrmProvider | undefined;
  notifications: NotificationProvider | undefined;
  handoff: PostBookingHandoffProvider | undefined;
}

/**
 * Build the configured operational integration adapters. No CRM, notification
 * or Service 3 vendor has been selected, so none exist: unset means deliveries
 * become BLOCKED, and a configured name fails startup instead of silently
 * doing nothing.
 */
export function createConfiguredIntegrations(config: AppConfig): IntegrationProviders {
  const { crm, notifications } = config.providers;
  if (crm.provider !== undefined) {
    throw new ConfigurationError(`CRM_PROVIDER "${crm.provider}" has no adapter`);
  }
  if (notifications.provider !== undefined) {
    throw new ConfigurationError(
      `OWNER_NOTIFICATION_PROVIDER "${notifications.provider}" has no adapter`,
    );
  }
  return { crm: undefined, notifications: undefined, handoff: undefined };
}
