import { type CompanionButtonPresetDefinition, type CompanionPresetDefinitions, combineRgb } from '@companion-module/base';
import { type CompanionState, hexToRgb, SLOTS, textColorFor } from './state.js';

const BLACK = combineRgb(0, 0, 0);
const WHITE = combineRgb(255, 255, 255);
const GREY = combineRgb(60, 60, 60);

function button(
  category: string,
  name: string,
  text: string,
  down: CompanionButtonPresetDefinition['steps'][number]['down'],
  feedbacks: CompanionButtonPresetDefinition['feedbacks'] = [],
  bgcolor = BLACK,
): CompanionButtonPresetDefinition {
  return {
    type: 'button',
    category,
    name,
    style: { text, size: 'auto', color: textColorFor(bgcolor) === 0 ? BLACK : WHITE, bgcolor },
    steps: [{ down, up: [] }],
    feedbacks,
  };
}

export function presetDefinitions(state: CompanionState | null): CompanionPresetDefinitions {
  const out: CompanionPresetDefinitions = {
    transport_toggle: button(
      'Transport',
      'Roll / Stop',
      '$(autologger:session_title)\n$(autologger:timecode)',
      [{ actionId: 'transport', options: { action: 'toggle' } }],
      [
        { feedbackId: 'rolling', options: {} },
        { feedbackId: 'no_session', options: {} },
      ],
    ),
    transport_start: button('Transport', 'Roll', 'ROLL', [{ actionId: 'transport', options: { action: 'start' } }], [
      { feedbackId: 'rolling', options: {} },
    ]),
    transport_stop: button('Transport', 'Stop', 'STOP', [{ actionId: 'transport', options: { action: 'stop' } }]),
    timecode: button(
      'Status',
      'Timecode',
      '$(autologger:timecode)\nTake $(autologger:take)',
      [],
      [{ feedbackId: 'rolling', options: {} }],
      GREY,
    ),
    last_event: button('Status', 'Last event', '$(autologger:last_event)', [], [], GREY),
    event_count: button('Status', 'Event count', 'Events\n$(autologger:event_count)', [], [], GREY),
  };

  for (const slot of SLOTS) {
    out[`slot_${slot}`] = button(
      'Event buttons',
      `Button ${slot}`,
      `$(autologger:cat_${slot})`,
      [{ actionId: 'log_slot', options: { slot, value: '', message: '' } }],
      [{ feedbackId: 'category_color', options: { slot } }],
    );
  }

  // One preset per dropdown option / toggle state of the current show's buttons.
  for (const cat of state?.categories ?? []) {
    const bg = hexToRgb(cat.color) ?? BLACK;
    const values =
      cat.kind === 'dropdown' ? cat.options : cat.kind === 'toggle' ? [cat.onLabel, cat.offLabel] : [];
    values.forEach((value, i) => {
      out[`opt_${cat.id}_${i}`] = button(
        `Options: ${cat.name}`,
        `${cat.name}: ${value}`,
        `${cat.name}\n${value}`,
        [{ actionId: 'log_event', options: { category: cat.id, value, message: '' } }],
        [],
        bg,
      );
    });
  }
  return out;
}
