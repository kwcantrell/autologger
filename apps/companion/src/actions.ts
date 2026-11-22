import type { CompanionActionDefinitions, DropdownChoice } from '@companion-module/base';
import { OpError } from './connection.js';
import { type Category, type CompanionOp, type CompanionState, categoryAtSlot, SLOTS } from './state.js';

export interface ActionHost {
  state(): CompanionState | null;
  request(op: CompanionOp, input?: Record<string, unknown>): Promise<unknown>;
  log(level: 'warn' | 'error' | 'info', msg: string): void;
  parseVariablesInString(text: string): Promise<string>;
}

/**
 * The value stored with an event. Toggle buttons accept `on`, `off` or `toggle` (flip the last
 * value this module sent for that button); other kinds pass the text through.
 */
export function resolveValue(cat: Category | undefined, raw: string, toggles: Map<string, boolean>): string | null {
  const v = raw.trim();
  if (cat?.kind === 'toggle') {
    let on: boolean;
    if (v.toLowerCase() === 'on' || v === cat.onLabel) on = true;
    else if (v.toLowerCase() === 'off' || v === cat.offLabel) on = false;
    else on = !(toggles.get(cat.id) ?? false);
    toggles.set(cat.id, on);
    return on ? cat.onLabel : cat.offLabel;
  }
  return v || null;
}

/** Event input for a button choice: an id of a current category, else a free category name. */
export function eventInput(
  state: CompanionState | null,
  categoryChoice: string,
  value: string,
  message: string,
  toggles: Map<string, boolean>,
): Record<string, unknown> {
  const cat = state?.categories.find((c) => c.id === categoryChoice);
  const out: Record<string, unknown> = cat ? { categoryId: cat.id } : { category: categoryChoice };
  const v = resolveValue(cat, value, toggles);
  if (v !== null) out.value = v;
  if (message) out.message = message;
  return out;
}

function report(host: ActionHost, verb: string, err: unknown): void {
  const msg = err instanceof Error ? err.message : String(err);
  host.log(err instanceof OpError && err.code !== 'internal' ? 'warn' : 'error', `${verb}: ${msg}`);
}

export function categoryChoices(state: CompanionState | null): DropdownChoice[] {
  return (state?.categories ?? []).map((c) => ({
    id: c.id,
    label: c.position < 9 ? `${c.position + 1}. ${c.name}` : c.name,
  }));
}

const VALUE_TOOLTIP =
  'Dropdown buttons: the option to log. Toggle buttons: on, off or toggle (empty = toggle). Other buttons: optional value.';

export function actionDefinitions(host: ActionHost): CompanionActionDefinitions {
  const toggles = new Map<string, boolean>();
  const choices = categoryChoices(host.state());

  const send = async (verb: string, op: CompanionOp, input: Record<string, unknown> = {}) => {
    try {
      await host.request(op, input);
    } catch (err) {
      report(host, verb, err);
    }
  };

  return {
    transport: {
      name: 'Transport: roll / stop / toggle',
      options: [
        {
          type: 'dropdown',
          id: 'action',
          label: 'Action',
          default: 'toggle',
          choices: [
            { id: 'toggle', label: 'Toggle' },
            { id: 'start', label: 'Roll (start)' },
            { id: 'stop', label: 'Stop' },
          ],
        },
      ],
      callback: async (action) => {
        let verb = String(action.options.action ?? 'toggle');
        if (verb === 'toggle') verb = host.state()?.session?.isRolling ? 'stop' : 'start';
        await send('transport', verb === 'stop' ? 'transport.stop' : 'transport.start');
      },
    },
    log_event: {
      name: 'Log event (choose button)',
      options: [
        {
          type: 'dropdown',
          id: 'category',
          label: 'Event button',
          default: choices[0]?.id ?? '',
          choices: choices.length ? choices : [{ id: '', label: '(not connected yet)' }],
          allowCustom: true,
          tooltip: 'Pick a button of the show, or type a free label',
        },
        { type: 'textinput', id: 'value', label: 'Option / value', default: '', useVariables: true, tooltip: VALUE_TOOLTIP },
        { type: 'textinput', id: 'message', label: 'Message', default: '', useVariables: true },
      ],
      callback: async (action) => {
        const category = String(action.options.category ?? '').trim();
        if (!category) return host.log('warn', 'log event: choose an event button');
        const value = await host.parseVariablesInString(String(action.options.value ?? ''));
        const message = await host.parseVariablesInString(String(action.options.message ?? ''));
        await send('log event', 'events.create', eventInput(host.state(), category, value, message, toggles));
      },
    },
    log_slot: {
      name: 'Log event by hotkey slot (1–9)',
      options: [
        {
          type: 'dropdown',
          id: 'slot',
          label: 'Slot',
          default: 1,
          choices: SLOTS.map((s) => ({ id: s, label: `Button ${s}` })),
        },
        { type: 'textinput', id: 'value', label: 'Option / value', default: '', useVariables: true, tooltip: VALUE_TOOLTIP },
        { type: 'textinput', id: 'message', label: 'Message', default: '', useVariables: true },
      ],
      callback: async (action) => {
        const slot = Number(action.options.slot);
        const cat = categoryAtSlot(host.state(), slot);
        if (!cat) return host.log('warn', `log event: the show has no button in slot ${slot}`);
        const value = await host.parseVariablesInString(String(action.options.value ?? ''));
        const message = await host.parseVariablesInString(String(action.options.message ?? ''));
        await send('log event', 'events.create', eventInput(host.state(), cat.id, value, message, toggles));
      },
    },
    refresh: {
      name: 'Refresh state from server',
      options: [],
      callback: async () => send('refresh', 'companion.state'),
    },
  };
}
