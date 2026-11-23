import { type CompanionFeedbackDefinitions, combineRgb } from '@companion-module/base';
import { type CompanionState, categoryStyle, SLOTS } from './state.js';

const WHITE = combineRgb(255, 255, 255);
const RED = combineRgb(200, 30, 30);
const AMBER = combineRgb(180, 120, 0);

// Presets repeat these as the feedback's `style`: Companion 5 treats a preset feedback without a
// style as an override of every property with empty values, which renders the key fully black.
export const ROLLING_STYLE = { bgcolor: RED, color: WHITE };
export const NO_SESSION_STYLE = { bgcolor: AMBER, color: WHITE };

export function feedbackDefinitions(
  getState: () => CompanionState | null,
): CompanionFeedbackDefinitions {
  return {
    rolling: {
      type: 'boolean',
      name: 'Transport is rolling',
      defaultStyle: ROLLING_STYLE,
      options: [],
      callback: () => Boolean(getState()?.session?.isRolling),
    },
    no_session: {
      type: 'boolean',
      name: 'No session to control (warning)',
      defaultStyle: NO_SESSION_STYLE,
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
