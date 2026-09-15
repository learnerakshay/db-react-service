import type { AppConfig } from '../../config/index.js';
import { ConfigurationError } from '../../lib/errors.js';
import type { CalendarProvider } from './index.js';

/**
 * Build the configured calendar provider, or undefined when CALENDAR_PROVIDER
 * is unset. No calendar vendor has been selected, so no adapter exists: a
 * configured name fails startup instead of silently doing nothing.
 */
export function createConfiguredCalendar(config: AppConfig): CalendarProvider | undefined {
  const { provider } = config.providers.calendar;
  if (provider === undefined) return undefined;
  throw new ConfigurationError(`CALENDAR_PROVIDER "${provider}" has no adapter`);
}
