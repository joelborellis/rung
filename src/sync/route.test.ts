// Hash parsing. The security-relevant case is that a token is recognised and
// then scrubbed; the compatibility-relevant one is that the existing
// #/scenario/<id> deep link still works untouched.

import { describe, expect, it } from 'vitest';
import { parseHash, scrubbedHash } from './route';

const TOKEN = 'rung_a1b2c3d4_aEyfexLqwS7cLe-3GrM2hiflMcCybAyaQhjYLvjX9P4';

describe('parseHash', () => {
  it('reads an invite link', () => {
    expect(parseHash(`#/t/${TOKEN}`)).toEqual({ token: TOKEN, scenarioId: null });
  });

  it('tolerates a trailing slash', () => {
    expect(parseHash(`#/t/${TOKEN}/`)).toEqual({ token: TOKEN, scenarioId: null });
  });

  it('reads the existing deep link unchanged', () => {
    expect(parseHash('#/scenario/collusion-003')).toEqual({
      token: null,
      scenarioId: 'collusion-003',
    });
  });

  it('reads an invite link that also deep-links', () => {
    expect(parseHash(`#/t/${TOKEN}/scenario/crisis-001`)).toEqual({
      token: TOKEN,
      scenarioId: 'crisis-001',
    });
  });

  it('decodes percent-encoding in a scenario id', () => {
    expect(parseHash('#/scenario/odd%20id').scenarioId).toBe('odd id');
  });

  it('survives a malformed escape rather than throwing on first paint', () => {
    expect(parseHash('#/scenario/100%').scenarioId).toBe('100%');
  });

  it.each([['empty', ''], ['bare hash', '#'], ['root', '#/'], ['unknown', '#/settings'], ['token with no value', '#/t/']])(
    'returns nothing for %s',
    (_label, hash) => {
      expect(parseHash(hash)).toEqual({ token: null, scenarioId: null });
    },
  );
});

describe('scrubbedHash', () => {
  it('drops the token entirely', () => {
    const scrubbed = scrubbedHash(parseHash(`#/t/${TOKEN}`));
    expect(scrubbed).toBe('#/');
    expect(scrubbed).not.toContain('rung_');
  });

  it('keeps a deep link so a shared invite still lands on the right scenario', () => {
    const scrubbed = scrubbedHash(parseHash(`#/t/${TOKEN}/scenario/crisis-001`));
    expect(scrubbed).toBe('#/scenario/crisis-001');
    expect(scrubbed).not.toContain(TOKEN);
  });

  it('re-encodes an id that needs it', () => {
    expect(scrubbedHash({ token: null, scenarioId: 'odd id' })).toBe('#/scenario/odd%20id');
  });
});
