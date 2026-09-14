export const KNOWLEDGE_CATEGORIES = [
  'BUSINESS_PROFILE',
  'SERVICES',
  'PRICING',
  'HOURS',
  'LOCATION',
  'ELIGIBILITY',
  'POLICY',
  'INSURANCE',
  'FAQ',
  'APPROVED_CLAIM',
  'BOOKING_PROCESS',
] as const;
export type KnowledgeCategory = (typeof KNOWLEDGE_CATEGORIES)[number];

/** An operator-approved fact the reply engine may use to answer questions. */
export interface KnowledgeItemDto {
  id: string;
  /** Null when the fact applies to every campaign. */
  campaignId: string | null;
  category: KnowledgeCategory;
  question: string | null;
  content: string;
  keywords: string[];
  active: boolean;
  createdAt: string;
}
