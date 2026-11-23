// The logging strip: one button per show category; hotkeys 1–9 while rolling. Button logs at
// once; Dropdown asks for an option, Text for a note (both pinned to the moment of the press);
// Toggle flips between its on/off labels (state derived from the last logged value).

import type { Category, Session, SessionEvent } from '@autologger/contract';
import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { errorMessage, rpc } from '@/api/rpc';
import { applyEntity } from '@/api/session/cache';
import { isTypingTarget } from '@/lib/keys';
import { settingsOpen } from '@/lib/store';
import { showToast } from '@/shared/components/Toast';
import { Button } from '@/shared/components/ui/button';
import { Field, FieldLabel } from '@/shared/components/ui/field';
import { Input } from '@/shared/components/ui/input';
import { Dialog, DialogActions } from '@/shared/ui/Dialog';
import { isOverlayOpen } from '@/shared/ui/overlayOpen';
import { Tooltip } from '@/shared/ui/Tooltip';
import { LogButton } from './LogButton';

type Pending = { cat: Category; atSec: number };

export function CategoryStrip({
  session,
  categories,
  events,
  enabled,
  disabledReason,
  elapsedSec,
}: {
  session: Session;
  categories: Category[];
  events: SessionEvent[];
  enabled: boolean;
  disabledReason: string | null;
  elapsedSec: () => number;
}) {
  const [dropdown, setDropdown] = useState<Pending | null>(null);
  const [text, setText] = useState<Pending | null>(null);
  const btnRefs = useRef(new Map<string, HTMLButtonElement>());

  // Toggle state: the last value logged for each toggle category.
  const phase = useMemo(() => {
    const m = new Map<string, 'on' | 'off'>();
    for (const e of events) {
      if (!e.categoryId) continue;
      if (e.value === 'ON') m.set(e.categoryId, 'on');
      else if (e.value === 'OFF') m.set(e.categoryId, 'off');
    }
    return m;
  }, [events]);

  const qc = useQueryClient();
  const log = useCallback(
    async (cat: Category, fields: { value?: string | null; message?: string; atSec?: number }) => {
      try {
        const ev = await rpc('events.create', {
          sessionId: session.id,
          categoryId: cat.id,
          ...fields,
        });
        // Show our own write without waiting for the socket echo (same keyed upsert, so the echo
        // is a no-op): toggles read their phase from it, and it shows while reconnecting.
        applyEntity(qc, session.id, { entity: 'event', op: 'upsert', id: ev.id, data: ev });
        showToast('Logged.');
      } catch (e) {
        showToast(`Couldn't log ${cat.name}. ${errorMessage(e)}`, true);
      }
    },
    [session.id, qc],
  );

  const press = useCallback(
    (cat: Category) => {
      if (!enabled) return;
      const el = btnRefs.current.get(cat.id);
      if (el) {
        el.classList.add('cat-btn-press');
        setTimeout(() => el.classList.remove('cat-btn-press'), 120);
      }
      const atSec = elapsedSec();
      switch (cat.kind) {
        case 'button':
          void log(cat, {});
          break;
        case 'toggle': {
          const on = phase.get(cat.id) !== 'on';
          void log(cat, {
            value: on ? 'ON' : 'OFF',
            message: (on ? cat.onLabel : cat.offLabel) || '',
          });
          break;
        }
        case 'dropdown':
          setDropdown({ cat, atSec });
          break;
        case 'text':
          setText({ cat, atSec });
          break;
      }
    },
    [enabled, elapsedSec, log, phase],
  );

  // Hotkeys 1–9.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!enabled || e.repeat || e.metaKey || e.ctrlKey || e.altKey) return;
      if (isTypingTarget(e.target) || isOverlayOpen()) return;
      const n = Number(e.key);
      if (!Number.isInteger(n) || n < 1 || n > 9) return;
      const cat = categories[n - 1];
      if (!cat) return;
      e.preventDefault();
      press(cat);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [enabled, categories, press]);

  if (categories.length === 0) {
    return (
      <p className="m-0 text-[0.85rem] text-si-muted">
        This show has no event buttons yet.{' '}
        <Button variant="link" size="inline" onClick={() => settingsOpen.set('event-buttons')}>
          Set them up in Settings → Event buttons
        </Button>
        .
      </p>
    );
  }

  return (
    <>
      <div
        className="cat-strip-scrollbar flex w-full min-w-0 flex-wrap content-center items-center gap-1.5"
        role="toolbar"
        aria-label="Log category"
      >
        {categories.map((cat, idx) => {
          const on = phase.get(cat.id) === 'on';
          const label =
            cat.kind === 'toggle'
              ? on
                ? cat.onLabel || cat.name
                : cat.offLabel || cat.name
              : cat.name;
          return (
            <Tooltip
              key={cat.id}
              shared
              content={idx < 9 ? `${cat.name} (${idx + 1})` : cat.name}
              disabled={!enabled}
            >
              <LogButton
                ref={(el: HTMLButtonElement | null) => {
                  if (el) btnRefs.current.set(cat.id, el);
                  else btnRefs.current.delete(cat.id);
                }}
                hotkey={idx < 9 ? idx + 1 : undefined}
                color={cat.color}
                label={label}
                srName={cat.kind === 'toggle' ? cat.name : undefined}
                latched={cat.kind === 'toggle' ? (on ? 'on' : 'off') : undefined}
                disabled={!enabled}
                // A disabled button gets no events, so the reason stays a native title.
                title={
                  enabled
                    ? undefined
                    : (disabledReason ?? (idx < 9 ? `${cat.name} (${idx + 1})` : cat.name))
                }
                onClick={() => press(cat)}
              />
            </Tooltip>
          );
        })}
      </div>
      {dropdown && (
        <DropdownDialog
          pending={dropdown}
          onClose={() => setDropdown(null)}
          onLog={(value, message) => {
            setDropdown(null);
            void log(dropdown.cat, { value, message, atSec: dropdown.atSec });
          }}
        />
      )}
      {text && (
        <TextDialog
          pending={text}
          onClose={() => setText(null)}
          onLog={(message) => {
            setText(null);
            void log(text.cat, { message, atSec: text.atSec });
          }}
        />
      )}
    </>
  );
}

function DropdownDialog({
  pending,
  onClose,
  onLog,
}: {
  pending: Pending;
  onClose: () => void;
  onLog: (value: string, message: string) => void;
}) {
  const [choice, setChoice] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const { cat } = pending;
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={choice ? 'Add a note' : 'Choose option'}
      description={cat.name}
    >
      {!choice ? (
        <div className="flex flex-col gap-2">
          {cat.options.length === 0 && (
            <p className="m-0 text-sm text-si-muted">
              This dropdown has no options yet. Add them in Settings → Event buttons.
            </p>
          )}
          {cat.options.map((o) => (
            <Button
              key={o}
              variant="outline"
              className="h-auto min-h-(--h-ctl) w-full justify-start whitespace-normal py-2 text-left"
              onClick={() => setChoice(o)}
            >
              {o}
            </Button>
          ))}
        </div>
      ) : (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            onLog(choice, note.trim());
          }}
        >
          <Field>
            <FieldLabel htmlFor="dropdown-note">Note (optional) for “{choice}”</FieldLabel>
            <Input
              id="dropdown-note"
              autoFocus
              maxLength={4000}
              value={note}
              onChange={(e) => setNote(e.target.value)}
            />
          </Field>
          <DialogActions>
            <Button type="button" variant="outline" onClick={() => setChoice(null)}>
              Back
            </Button>
            <Button type="submit">Log</Button>
          </DialogActions>
        </form>
      )}
    </Dialog>
  );
}

function TextDialog({
  pending,
  onClose,
  onLog,
}: {
  pending: Pending;
  onClose: () => void;
  onLog: (message: string) => void;
}) {
  const [note, setNote] = useState('');
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title="Log note"
      description={`Add a note for “${pending.cat.name}”. Press Enter or Log.`}
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (note.trim()) onLog(note.trim());
        }}
      >
        <Field>
          <FieldLabel htmlFor="text-note">Note</FieldLabel>
          <Input
            id="text-note"
            autoFocus
            maxLength={5000}
            value={note}
            onChange={(e) => setNote(e.target.value)}
          />
        </Field>
        <DialogActions>
          <Button type="button" variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" disabled={!note.trim()}>
            Log
          </Button>
        </DialogActions>
      </form>
    </Dialog>
  );
}
