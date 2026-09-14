/**
 * CRM provider boundary. PROVISIONAL — finalized in Phase 3.
 * No adapters exist in Phase 0. The local database stays authoritative; the
 * CRM is a downstream mirror.
 */

export interface CrmProvider {
  readonly name: string;
}
