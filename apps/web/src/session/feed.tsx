// Feed chrome shared by every workspace tab: the panel card with a count heading and a toolbar,
// a table with sticky label-type headers, cell faces, and the leading jump-to-time button.

import { Check, Clock, Download, Filter, Pencil, Play, Plus, X } from 'lucide-react';
import type { ReactNode } from 'react';
import { Button } from '@/shared/components/ui/button';
import { cn } from '@/shared/lib/utils';

export function feedCountLabel(count: number, noun: string) {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

export function FeedShell({
  countLabel,
  toolbar,
  children,
  className,
  id,
}: {
  countLabel: ReactNode;
  toolbar?: ReactNode;
  children: ReactNode;
  className?: string;
  id?: string;
}) {
  return (
    <div
      id={id}
      className={cn(
        'relative z-[1] mx-4 box-border flex min-w-0 flex-[1_1_auto] flex-col rounded-card border border-si-line bg-si-panel px-6 pt-3 pb-6 max-md:mx-3 max-md:px-3 max-md:pb-3',
        className,
      )}
    >
      <div className="mb-2 flex w-full min-w-0 shrink-0 flex-row items-start justify-between gap-x-5 gap-y-4 max-md:flex-wrap">
        <h2
          role="status"
          className="m-0 min-w-0 flex-1 text-left font-ui text-[1.25rem] font-semibold leading-tight tabular-nums text-si-fg"
        >
          {countLabel}
        </h2>
        {toolbar && (
          <div
            role="toolbar"
            className="flex max-w-full flex-row flex-wrap justify-start gap-2 self-start"
          >
            {toolbar}
          </div>
        )}
      </div>
      {children}
    </div>
  );
}

/** Toolbar caption: label on desktop, icon-only on phones. */
export function ToolbarCaption({ label, icon }: { label: string; icon: ReactNode }) {
  return (
    <>
      <span className="inline-flex items-center justify-center md:hidden" aria-hidden="true">
        {icon}
      </span>
      <span className="max-md:sr-only">{label}</span>
    </>
  );
}

const ICON = { className: 'block size-[18px]', 'aria-hidden': true } as const;
export const IconPlus = () => <Plus {...ICON} />;
export const IconPencil = () => <Pencil {...ICON} />;
export const IconCheck = () => <Check {...ICON} />;
export const IconX = () => <X {...ICON} />;
export const IconClock = () => <Clock {...ICON} />;
export const IconFilter = () => <Filter {...ICON} />;
export const IconDownload = () => <Download {...ICON} />;

export const FEED_EMPTY =
  'px-4 py-[1.35rem] text-center text-[0.85rem] text-si-muted border border-si-line rounded-card bg-[rgba(0,0,0,0.22)]';
export const FEED_ROW = 'hover-always:bg-[rgba(255,255,255,0.03)]';
export const FEED_CELL =
  'px-[0.4rem] py-[0.1rem] text-[0.78rem] [border-bottom:1px_solid_rgba(255,255,255,0.04)]';
export const FEED_TC = 'font-tc text-legacy-accent whitespace-nowrap tabular-nums';
export const FEED_CELL_TEXT = 'text-(--color-text)';
export const FEED_CELL_LABEL = 'text-(--color-text) font-semibold';
export const FEED_TH =
  'sticky top-0 z-[1] bg-si-panel px-[0.4rem] py-1.5 text-left font-label text-[0.6875rem] font-semibold uppercase tracking-[0.12em] text-si-dim whitespace-nowrap';
export const FEED_INLINE_INPUT =
  'w-full px-[0.3rem] py-[0.18rem] bg-transparent border border-solid border-transparent rounded-[3px] text-inherit [font-family:inherit] [font-size:inherit] [font-weight:inherit] [line-height:inherit] outline-none focus:border-[color-mix(in_oklab,var(--si-accent)_55%,transparent)] focus:bg-[color-mix(in_oklab,var(--si-accent)_8%,transparent)] [&[type=number]::-webkit-inner-spin-button]:appearance-none';
export const FEED_TEXTAREA =
  'block box-border min-h-[1.6rem] resize-none overflow-hidden whitespace-pre-wrap [overflow-wrap:anywhere] leading-[1.35] field-sizing-content';

export interface Column {
  key: string;
  label: string;
  className?: string;
  srOnly?: boolean;
}

/**
 * Narrow feeds stack each row instead of drawing a table: a meta line (jump, time, who/what,
 * actions) above the row's text at full width. It follows the feed's own width (container
 * `feed`), not the viewport, so phones, tablets with the rail open and the landing page's
 * half-width mocks all get it. `narrow` stacks below 28rem; `wide` below 48rem, for change-log
 * rows, whose meta columns alone need ~30rem. Rows place their cells under the matching variant
 * (`@max-md/feed:` for narrow, `@max-3xl/feed:` for wide), starting from FEED_STACK_ROW.
 */
export type FeedStack = 'narrow' | 'wide';
const STACK_TABLE: Record<FeedStack, string> = {
  narrow:
    '@max-md/feed:block @max-md/feed:[&>tbody]:block @max-md/feed:[&>thead]:sr-only @max-md/feed:[&>tbody>tr>td]:[border-bottom:0]',
  wide: '@max-3xl/feed:block @max-3xl/feed:[&>tbody]:block @max-3xl/feed:[&>thead]:sr-only @max-3xl/feed:[&>tbody>tr>td]:[border-bottom:0]',
};
const STACK_BLOCK: Record<FeedStack, string> = {
  narrow: '@max-md/feed:block',
  wide: '@max-3xl/feed:block',
};
/** A stacked row: a grid with the row's divider (cells drop theirs). Rows add grid-cols. */
export const FEED_STACK_ROW: Record<FeedStack, string> = {
  narrow:
    '@max-md/feed:grid @max-md/feed:items-center @max-md/feed:gap-x-1 @max-md/feed:py-1 @max-md/feed:[border-bottom:1px_solid_rgba(255,255,255,0.04)]',
  wide: '@max-3xl/feed:grid @max-3xl/feed:items-center @max-3xl/feed:gap-x-1 @max-3xl/feed:py-1 @max-3xl/feed:[border-bottom:1px_solid_rgba(255,255,255,0.04)]',
};

/** A plain scrolling feed table. Rows are passed as children (<tr>). */
export function FeedTable({
  columns,
  loading,
  empty,
  emptyMessage,
  children,
  maxHeight = 'md:max-h-[calc(100dvh-var(--topbar-h)-20rem)] max-md:max-h-[70dvh]',
  stack = 'narrow',
}: {
  columns: Column[];
  loading?: boolean;
  empty?: boolean;
  emptyMessage?: ReactNode;
  children?: ReactNode;
  maxHeight?: string;
  /** Width below which the rows stack (FeedStack); must match the rows' own variants. */
  stack?: FeedStack;
}) {
  const block = STACK_BLOCK[stack];
  return (
    // `relative`: the stacked table's sr-only header is absolute; it stays inside this scroller.
    <div className={cn('@container/feed relative min-h-[8rem] overflow-auto', maxHeight)}>
      <table className={cn('w-full border-collapse', STACK_TABLE[stack])}>
        <thead>
          <tr>
            {columns.map((c) => (
              <th key={c.key} scope="col" className={cn(FEED_TH, c.className)}>
                {c.srOnly ? <span className="sr-only">{c.label}</span> : c.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {loading ? (
            <tr className={block}>
              <td colSpan={columns.length} className={cn('pt-2', block)}>
                <div className={FEED_EMPTY}>Loading…</div>
              </td>
            </tr>
          ) : empty ? (
            <tr className={block}>
              <td colSpan={columns.length} className={cn('pt-2', block)}>
                <div className={FEED_EMPTY}>{emptyMessage}</div>
              </td>
            </tr>
          ) : (
            children
          )}
        </tbody>
      </table>
    </div>
  );
}

const JUMP_BTN =
  'inline-flex h-6 w-6 shrink-0 cursor-pointer items-center justify-center rounded-[0.35rem] border border-transparent bg-transparent p-0 text-si-muted [transition:border-color_0.15s_ease,color_0.15s_ease,background_0.15s_ease] hover-always:border-(--sel-line) hover-always:bg-(--sel-bg) hover-always:text-(--si-accent) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring aria-disabled:pointer-events-none aria-disabled:cursor-not-allowed aria-disabled:opacity-45';

export const JUMP_COLUMN: Column = {
  key: 'jump',
  label: 'Jump to time',
  className: 'w-8',
  srOnly: true,
};

/** Leading play button that seeks the session audio to a row's time. */
export function JumpButton({
  sec,
  label,
  onJump,
  unavailable,
}: {
  sec: number | null;
  label: string;
  onJump: (sec: number) => void;
  unavailable?: string | null;
}) {
  if (sec == null) return null;
  return (
    <Button
      variant="unstyled"
      className={JUMP_BTN}
      aria-label={`Jump to ${label}`}
      title={unavailable ?? `Jump to ${label}`}
      aria-disabled={unavailable ? true : undefined}
      onClick={() => {
        if (!unavailable) onJump(sec);
      }}
    >
      <Play className="size-3" fill="currentColor" aria-hidden="true" />
    </Button>
  );
}
