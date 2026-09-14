import type { DbClient } from '../../db/client.js';
import { KnowledgeCategory } from '../../generated/prisma/enums.js';

export interface RetrievedFact {
  id: string;
  category: KnowledgeCategory;
  question: string | null;
  content: string;
  score: number;
}

interface CandidateFact {
  id: string;
  category: KnowledgeCategory;
  question: string | null;
  content: string;
  keywords: string[];
}

/** Cap on facts scored per question. */
const MAX_CANDIDATES = 500;

const STOPWORDS = new Set([
  'the',
  'and',
  'for',
  'you',
  'your',
  'are',
  'what',
  'how',
  'can',
  'does',
  'with',
  'have',
  'this',
  'that',
  'from',
  'about',
  'there',
  'they',
  'will',
  'would',
  'could',
  'any',
  'our',
  'just',
  'still',
  'want',
  'need',
  'know',
  'which',
  'who',
  'why',
  'did',
  'was',
  'were',
  'has',
  'yes',
  'hey',
  'please',
  'thanks',
  'thank',
  'get',
  'got',
  'also',
  'some',
  'into',
  'more',
]);

const CATEGORY_HINTS: readonly [KnowledgeCategory, RegExp][] = [
  [
    KnowledgeCategory.PRICING,
    /\b(price|prices|pricing|cost|costs|how much|fee|fees|charge|quote|rate|rates)\b|\$/i,
  ],
  [KnowledgeCategory.HOURS, /\b(hours|open|opening|closed?|closing|weekends?|saturday|sunday)\b/i],
  [KnowledgeCategory.LOCATION, /\b(where|address|located|location|directions|parking)\b/i],
  [KnowledgeCategory.INSURANCE, /\b(insurance|insured|covered|coverage)\b/i],
  [KnowledgeCategory.BOOKING_PROCESS, /\b(book|booking|schedule|appointment|reserve|sign up)\b/i],
  [KnowledgeCategory.ELIGIBILITY, /\b(eligible|eligibility|qualify|requirements?)\b/i],
  [KnowledgeCategory.POLICY, /\b(policy|policies|cancellation|refund|guarantee|warranty)\b/i],
  [KnowledgeCategory.SERVICES, /\b(services?|offer|provide)\b/i],
  [KnowledgeCategory.BUSINESS_PROFILE, /\b(who are you|who is this|company|business)\b/i],
];

/**
 * Deterministic retrieval over approved facts: active facts for the campaign
 * plus business-wide facts, scored by keyword overlap (operator keywords
 * weigh most) and category hints from the question. Facts with no signal are
 * never returned, so an unanswerable question yields an empty result.
 *
 * ponytail: lexical scoring over at most 500 facts; embeddings are the upgrade
 * path if knowledge bases grow large or questions paraphrase heavily.
 */
export async function retrieveRelevantKnowledge(
  db: DbClient,
  request: { campaignId: string | null; query: string; limit: number },
): Promise<RetrievedFact[]> {
  const candidates = await db.knowledgeItem.findMany({
    where: {
      active: true,
      OR: [
        { campaignId: null },
        ...(request.campaignId === null ? [] : [{ campaignId: request.campaignId }]),
      ],
    },
    orderBy: { id: 'asc' },
    take: MAX_CANDIDATES,
    select: { id: true, category: true, question: true, content: true, keywords: true },
  });
  return rankKnowledge(candidates, request.query, request.limit);
}

export function rankKnowledge(
  candidates: readonly CandidateFact[],
  query: string,
  limit: number,
): RetrievedFact[] {
  const queryTokens = tokenize(query);
  const hinted = new Set(
    CATEGORY_HINTS.filter(([, pattern]) => pattern.test(query)).map(([category]) => category),
  );

  return candidates
    .map((fact) => {
      const keywordTokens = tokenize(fact.keywords.join(' '));
      const textTokens = tokenize(`${fact.question ?? ''} ${fact.content}`);
      let score = hinted.has(fact.category) ? 2 : 0;
      for (const token of queryTokens) {
        if (keywordTokens.has(token)) score += 3;
        else if (textTokens.has(token)) score += 1;
      }
      return {
        id: fact.id,
        category: fact.category,
        question: fact.question,
        content: fact.content,
        score,
      };
    })
    .filter((fact) => fact.score > 0)
    .sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .slice(0, limit);
}

function tokenize(text: string): Set<string> {
  const tokens = new Set<string>();
  for (const raw of text.toLowerCase().split(/[^a-z0-9]+/)) {
    if (raw.length < 3 || STOPWORDS.has(raw)) continue;
    tokens.add(raw.length > 3 && raw.endsWith('s') ? raw.slice(0, -1) : raw);
  }
  return tokens;
}
