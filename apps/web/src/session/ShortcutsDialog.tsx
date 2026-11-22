import { MOD_KEY_LABEL } from '@/lib/keys';
import { shortcutsOpen, useStore } from '@/lib/store';
import { Dialog } from '@/shared/ui/Dialog';

const KEY =
  'inline-flex min-w-[1.7rem] items-center justify-center rounded-[0.4rem] border border-si-line bg-si-panel-2 px-[0.4rem] py-[0.15rem] font-tc text-[0.72rem] font-semibold text-si-fg';

const ROWS: { keys: string[]; text: string }[] = [
  { keys: ['1–9'], text: 'Log the 1st–9th event button (while timecode is rolling)' },
  { keys: ['Space'], text: 'Play / pause recorded audio' },
  { keys: ['←', '→'], text: 'Scrub the timeline 1s when the playhead is focused (hold Shift for 10s)' },
  { keys: ['+', '−'], text: 'Zoom the timeline in / out' },
  { keys: ['['], text: 'Show or hide the sidebar' },
  { keys: [MOD_KEY_LABEL, 'K'], text: 'Search sessions, transcripts, topics and events' },
  { keys: ['Esc'], text: 'Close dialogs and the drawer' },
  { keys: ['?'], text: 'Open this shortcut reference' },
];

export function ShortcutsDialog() {
  const open = useStore(shortcutsOpen);
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => shortcutsOpen.set(o)}
      title="Keyboard shortcuts"
      description="Shortcuts stay out of the way while you type in any field."
    >
      <ul className="m-0 flex list-none flex-col gap-2.5 p-0">
        {ROWS.map((r) => (
          <li key={r.text} className="flex items-center justify-between gap-4">
            <span className="text-[0.85rem] text-si-muted">{r.text}</span>
            <span className="flex shrink-0 gap-1">
              {r.keys.map((k) => (
                <kbd key={k} className={KEY}>
                  {k}
                </kbd>
              ))}
            </span>
          </li>
        ))}
      </ul>
    </Dialog>
  );
}
