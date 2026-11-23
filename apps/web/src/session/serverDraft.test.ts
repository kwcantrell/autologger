// Inline editors keep the user's draft when the server value changes under it (#231).

import { describe, expect, it } from 'vitest';
import { type DraftState, hasConflict, initialDraft, reconcile } from './serverDraft';

const typed = (st: DraftState, draft: string): DraftState => ({ ...st, draft });

describe('server drafts', () => {
  it('follow the server while the user has not edited', () => {
    const st = reconcile(initialDraft('orig'), 'orig (fixed by agent)');
    expect(st).toEqual(initialDraft('orig (fixed by agent)'));
    expect(reconcile(st, 'orig (fixed by agent)')).toBe(st);
  });

  it('keep the draft when the server changes under an edit, and flag the conflict', () => {
    const st = typed(initialDraft('orig'), 'orig + my typing');
    const after = reconcile(st, 'orig (fixed by agent)');
    expect(after.draft).toBe('orig + my typing');
    expect(hasConflict(after, 'orig (fixed by agent)')).toBe(true);
    expect(hasConflict(after, 'orig')).toBe(false);
  });

  it('settle when the remote value equals the draft', () => {
    const st = typed(initialDraft('orig'), 'same');
    expect(reconcile(st, 'same')).toEqual(initialDraft('same'));
  });

  it('resume following the server once the draft is typed back to where it started', () => {
    const st = typed(typed(initialDraft('orig'), 'origx'), 'orig');
    expect(reconcile(st, 'remote')).toEqual(initialDraft('remote'));
  });

  it('show the saved value until the server echoes it, then follow the server again', () => {
    // commit('mine') while the server still says 'orig'
    const saving: DraftState = { draft: 'mine', base: 'mine', awaiting: 'orig' };
    expect(reconcile(saving, 'orig')).toBe(saving);
    const echoed = reconcile(saving, 'mine');
    expect(echoed).toEqual(initialDraft('mine'));
    expect(reconcile(echoed, 'orig')).toEqual(initialDraft('orig'));
  });

  it('take a normalised echo or a later remote change after a save', () => {
    const saving: DraftState = { draft: 'mine ', base: 'mine ', awaiting: 'orig' };
    expect(reconcile(saving, 'mine')).toEqual(initialDraft('mine'));
  });
});
