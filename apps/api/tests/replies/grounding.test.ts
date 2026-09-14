import { describe, expect, it } from 'vitest';
import type { RetrievedFact } from '../../src/modules/knowledge/retrieval.js';
import { validateGroundedAnswer } from '../../src/modules/replies/grounding.js';

const facts: RetrievedFact[] = [
  {
    id: 'fact-price',
    category: 'PRICING',
    question: 'How much is a cleaning?',
    content:
      'A standard gutter cleaning is $149 for single-story homes and $1,249 for commercial roofs.',
    score: 5,
  },
  {
    id: 'fact-hours',
    category: 'HOURS',
    question: null,
    content: 'We are open Monday to Friday, 8:00 to 17:00. Questions: help@acme.example',
    score: 2,
  },
];

describe('grounded answer validation', () => {
  it('accepts an answer whose details all appear in the cited facts', () => {
    expect(
      validateGroundedAnswer(
        {
          answerable: true,
          answer: '  A standard cleaning is $149 for single-story homes. ',
          citedFactIds: ['fact-price'],
        },
        facts,
        320,
      ),
    ).toEqual({
      ok: true,
      answer: 'A standard cleaning is $149 for single-story homes.',
      citedFactIds: ['fact-price'],
    });

    expect(
      validateGroundedAnswer(
        {
          answerable: true,
          answer: 'Commercial roofs are $1249. We are open 8:00 to 17:00.',
          citedFactIds: ['fact-price', 'fact-hours'],
        },
        facts,
        320,
      ).ok,
    ).toBe(true);
  });

  it.each([
    [{ answerable: false, answer: null, citedFactIds: [] }, 'NOT_ANSWERABLE'],
    [{ answerable: true, answer: '   ', citedFactIds: ['fact-price'] }, 'EMPTY'],
    [{ answerable: true, answer: 'x'.repeat(321), citedFactIds: ['fact-price'] }, 'TOO_LONG'],
    [{ answerable: true, answer: 'It is affordable.', citedFactIds: [] }, 'NO_CITATIONS'],
    [
      { answerable: true, answer: 'It is affordable.', citedFactIds: ['fact-invented'] },
      'UNKNOWN_CITATION',
    ],
    [
      { answerable: true, answer: 'A cleaning is $99.', citedFactIds: ['fact-price'] },
      'UNSUPPORTED_DETAIL',
    ],
    [
      { answerable: true, answer: 'We are open 24/7.', citedFactIds: ['fact-hours'] },
      'UNSUPPORTED_DETAIL',
    ],
    [
      {
        answerable: true,
        answer: 'Cleaning is $149, we are open 8:00.',
        citedFactIds: ['fact-price'],
      },
      'UNSUPPORTED_DETAIL',
    ],
    [
      {
        answerable: true,
        answer: 'Book at https://acme.example/book',
        citedFactIds: ['fact-hours'],
      },
      'UNSUPPORTED_DETAIL',
    ],
    [
      { answerable: true, answer: 'Email sales@acme.example', citedFactIds: ['fact-hours'] },
      'UNSUPPORTED_DETAIL',
    ],
  ] as const)('rejects %o as %s', (answer, reason) => {
    expect(
      validateGroundedAnswer({ ...answer, citedFactIds: [...answer.citedFactIds] }, facts, 320),
    ).toEqual({
      ok: false,
      reason,
    });
  });

  it('allows contact details that are in the cited fact', () => {
    expect(
      validateGroundedAnswer(
        {
          answerable: true,
          answer: 'You can email help@acme.example anytime.',
          citedFactIds: ['fact-hours'],
        },
        facts,
        320,
      ).ok,
    ).toBe(true);
  });
});
