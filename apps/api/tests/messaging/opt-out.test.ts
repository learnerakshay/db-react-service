import { describe, expect, it } from 'vitest';
import { isHardOptOut } from '../../src/modules/messaging/opt-out.js';

describe('hard opt-out detection', () => {
  it.each([
    'STOP',
    'stop',
    '  Stop  ',
    'STOP.',
    'stop!',
    '"STOP"',
    'UNSUBSCRIBE',
    'remove',
    'Cancel',
    'END',
    'quit',
    'STOPALL',
    'opt out',
    'Opt-Out',
    'REVOKE',
    'ＳＴＯＰ',
  ])('treats %j as an unmistakable opt-out', (body) => {
    expect(isHardOptOut(body)).toBe(true);
  });

  it.each([
    'not now',
    'maybe later',
    'who is this?',
    "don't think so",
    'stop texting me',
    'please stop',
    'STOP IT',
    'unsubscribe me please',
    'end of month works',
    'cancel my appointment',
    'stopped by yesterday',
    '',
  ])('leaves %j for classification', (body) => {
    expect(isHardOptOut(body)).toBe(false);
  });
});
