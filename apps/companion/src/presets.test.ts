import { describe, expect, it } from 'vitest';
import { feedbackDefinitions } from './feedbacks.js';
import { presetDefinitions } from './presets.js';
import type { CompanionState } from './state.js';

const state = {
  categories: [
    {
      id: 'cat_1',
      showId: 'shw_1',
      position: 0,
      name: 'Mood',
      color: '#00aa00',
      kind: 'dropdown',
      options: ['Up', 'Down'],
      onLabel: 'ON',
      offLabel: 'OFF',
    },
  ],
} as unknown as CompanionState;

describe('presets', () => {
  // Companion 5 renders a boolean feedback without a preset style as a fully black key.
  it('gives every boolean feedback reference the feedback default style', () => {
    const defs = feedbackDefinitions(() => null);
    const refs = Object.values(presetDefinitions(state)).flatMap((p) =>
      p.type === 'button' ? p.feedbacks : [],
    );
    expect(refs.length).toBeGreaterThan(0);
    for (const ref of refs) {
      const def = defs[ref.feedbackId];
      expect(def, ref.feedbackId).toBeDefined();
      if (def?.type !== 'boolean') continue;
      expect(ref.style, ref.feedbackId).toEqual(def.defaultStyle);
      expect(Object.keys(ref.style ?? {}).length, ref.feedbackId).toBeGreaterThan(0);
    }
  });
});
