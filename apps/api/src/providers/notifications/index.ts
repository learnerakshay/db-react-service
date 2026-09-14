/**
 * Owner notification provider boundary. PROVISIONAL — finalized in Phase 3.
 * No adapters exist in Phase 0.
 */

export interface OwnerNotification {
  subject: string;
  body: string;
  idempotencyKey: string;
}

export interface NotificationProvider {
  readonly name: string;
  notify(notification: OwnerNotification): Promise<void>;
}
