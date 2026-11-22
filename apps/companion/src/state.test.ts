import { describe, expect, it } from 'vitest';
import { eventInput, resolveValue } from './actions.js';
import { backoffDelay } from './connection.js';
import {
  type Category,
  type CompanionState,
  categoryStyle,
  formatFrames,
  liveState,
  socketUrl,
  timecodeAt,
  toVariableValues,
  transportFrames,
} from './state.js';

const cat = (p: Partial<Category> & { id: string; position: number }): Category => ({
  showId: 'shw_1',
  name: `Cat ${p.position + 1}`,
  color: '#ff0000',
  kind: 'button',
  options: [],
  onLabel: 'ON',
  offLabel: 'OFF',
  ...p,
});

const T0 = Date.parse('2026-01-01T10:00:00.000Z');

function state(over: Partial<CompanionState['session'] & object> = {}): CompanionState {
  return {
    device: { id: 'dev_1', name: 'Deck' },
    show: { id: 'shw_1', name: 'Morning Show' },
    session: {
      id: 'ses_1',
      title: 'MS 2026-01-01',
      isRolling: false,
      rollStartedAt: null,
      elapsedFrames: 0,
      take: 2,
      frameRate: 25,
      startOffsetFrames: 0,
      eventCount: 7,
      ...over,
    },
    categories: [
      cat({ id: 'c1', position: 0, name: 'Guest', color: '#ffee00' }),
      cat({ id: 'c2', position: 1, name: 'Ad', color: '#102030', kind: 'dropdown', options: ['A', 'B'] }),
      cat({ id: 'c3', position: 2, name: 'Live', kind: 'toggle', onLabel: 'LIVE', offLabel: 'OFF AIR' }),
    ],
    lastEvent: { id: 'evt_1', category: 'Guest', message: 'arrives', timecodeFrames: 25 * 61 + 3 },
  };
}

describe('state → variables', () => {
  it('maps session, show, last event and slots', () => {
    const v = toVariableValues(liveState(state(), new Date(T0).toISOString(), T0), T0);
    expect(v).toMatchObject({
      session_title: 'MS 2026-01-01',
      show_name: 'Morning Show',
      device_name: 'Deck',
      timecode: '00:00:00:00',
      take: 2,
      event_count: 7,
      rolling: 'STOPPED',
      last_event: 'Guest: arrives',
      last_event_timecode: '00:01:01:03',
      cat_1: 'Guest',
      cat_2: 'Ad',
      cat_3: 'Live',
      cat_4: '',
    });
  });

  it('handles no session and no state', () => {
    const s = { ...state(), session: null, lastEvent: null };
    expect(toVariableValues(liveState(s, new Date(T0).toISOString(), T0), T0)).toMatchObject({
      session_title: '(no session)',
      timecode: '--:--:--:--',
      take: '',
      last_event: '',
    });
    expect(toVariableValues(null, T0).show_name).toBe('');
  });

  it('last event without message shows only the category', () => {
    const s = state();
    s.lastEvent = { id: 'e', category: 'Ad', message: '', timecodeFrames: 0 };
    expect(toVariableValues(liveState(s, new Date(T0).toISOString(), T0), T0).last_event).toBe('Ad');
  });
});

describe('timecode', () => {
  it('formats frames and drop-frame separator', () => {
    expect(formatFrames(25 * 3600 + 25 * 62 + 4, 25)).toBe('01:01:02:04');
    expect(formatFrames(30 * 10, 29.97)).toBe('00:00:10;00');
  });

  it('ticks locally while rolling, including start offset and elapsed', () => {
    const s = state({
      isRolling: true,
      rollStartedAt: new Date(T0).toISOString(),
      elapsedFrames: 50,
      startOffsetFrames: 25 * 3600,
    }).session!;
    expect(transportFrames(s, T0)).toBe(25 * 3600 + 50);
    expect(transportFrames(s, T0 + 1000)).toBe(25 * 3600 + 75);
    const live = liveState(state({ ...s }), new Date(T0).toISOString(), T0);
    expect(timecodeAt(live, T0 + 2_040)).toBe('01:00:04:01');
  });

  it('corrects for clock offset between server and module', () => {
    const s = state({ isRolling: true, rollStartedAt: new Date(T0).toISOString() });
    // Our clock runs 5 s behind the server: server says T0+1s when we read T0-4s.
    const live = liveState(s, new Date(T0 + 1000).toISOString(), T0 - 4000);
    expect(timecodeAt(live, T0 - 3000)).toBe('00:00:02:00');
  });

  it('does not move while stopped', () => {
    const live = liveState(state({ elapsedFrames: 100 }), new Date(T0).toISOString(), T0);
    expect(timecodeAt(live, T0 + 60_000)).toBe('00:00:04:00');
  });
});

describe('colors and events', () => {
  it('category style picks contrasting text', () => {
    expect(categoryStyle(state(), 1)).toEqual({ bgcolor: 0xffee00, color: 0x000000 });
    expect(categoryStyle(state(), 2)).toEqual({ bgcolor: 0x102030, color: 0xffffff });
    expect(categoryStyle(state(), 9)).toBeNull();
  });

  it('toggle values flip and accept on/off', () => {
    const s = state();
    const live = s.categories[2]!;
    const mem = new Map<string, boolean>();
    expect(resolveValue(live, '', mem)).toBe('LIVE');
    expect(resolveValue(live, 'toggle', mem)).toBe('OFF AIR');
    expect(resolveValue(live, 'on', mem)).toBe('LIVE');
    expect(resolveValue(s.categories[1], ' B ', mem)).toBe('B');
    expect(resolveValue(s.categories[0], '', mem)).toBeNull();
  });

  it('builds event input by id or free label', () => {
    const s = state();
    expect(eventInput(s, 'c2', 'A', 'msg', new Map())).toEqual({ categoryId: 'c2', value: 'A', message: 'msg' });
    expect(eventInput(s, 'Note', '', '', new Map())).toEqual({ category: 'Note' });
  });
});

describe('connection helpers', () => {
  it('derives the socket url', () => {
    expect(socketUrl('http://host:8787/')).toBe('ws://host:8787/ws/companion');
    expect(socketUrl('https://al.example.com')).toBe('wss://al.example.com/ws/companion');
    expect(socketUrl('127.0.0.1:18084')).toBe('ws://127.0.0.1:18084/ws/companion');
    expect(socketUrl('wss://x/ws/companion')).toBe('wss://x/ws/companion');
  });

  it('backs off exponentially with a cap', () => {
    expect(backoffDelay(0, () => 0.5)).toBe(1000);
    expect(backoffDelay(3, () => 0.5)).toBe(8000);
    expect(backoffDelay(20, () => 0.5)).toBe(30000);
  });
});
