import type { CompanionVariableDefinition } from '@companion-module/base';
import { SLOTS } from './state.js';

export function variableDefinitions(): CompanionVariableDefinition[] {
  return [
    { variableId: 'session_title', name: 'Session title' },
    { variableId: 'show_name', name: 'Show name' },
    { variableId: 'device_name', name: 'Device name' },
    { variableId: 'timecode', name: 'Session timecode (ticks while rolling)' },
    { variableId: 'take', name: 'Current take' },
    { variableId: 'rolling', name: 'Transport state (ROLLING / STOPPED)' },
    { variableId: 'frame_rate', name: 'Frame rate' },
    { variableId: 'event_count', name: 'Logged event count' },
    { variableId: 'last_event', name: 'Last logged event' },
    { variableId: 'last_event_timecode', name: 'Timecode of the last logged event' },
    ...SLOTS.map((slot) => ({ variableId: `cat_${slot}`, name: `Event button ${slot} name` })),
  ];
}
