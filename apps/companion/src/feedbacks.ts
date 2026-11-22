import { type CompanionFeedbackDefinitions, combineRgb } from '@companion-module/base';
import { type CompanionState, categoryStyle, SLOTS } from './state.js';

const WHITE = combineRgb(255, 255, 255);
const RED = combineRgb(200, 30, 30);
const AMBER = combineRgb(180, 120, 0);

export function feedbackDefinitions(
  getState: () => CompanionState | null,
): CompanionFeedbackDefinitions {
  return {
    rolling: {
      type: 'boolean',
      name: 'Transport is rolling',
      defaultStyle: { bgcolor: RED, color: WHITE },
      options: [],
      callback: () => Boolean(getState()?.session?.isRolling),
    },
    no_session: {
      type: 'boolean',
      name: 'No session to control (warning)',
      defaultStyle: { bgcolor: AMBER, color: WHITE },
      options: [],
      callback: () => !getState()?.session,
    },
    category_color: {
      type: 'advanced',
      name: 'Event button color (from the show)',
      description: 'Colors the button like the AutoLogger event button in the chosen slot',
      options: [
        {
          type: 'dropdown',
          id: 'slot',
          label: 'Slot',
          default: 1,
          choices: SLOTS.map((s) => ({ id: s, label: `Button ${s}` })),
        },
      ],
      callback: (fb) => categoryStyle(getState(), Number(fb.options.slot)) ?? {},
    },
  };
}
