// One logging-strip button face: hotkey, category swatch and label. Presentational (props in,
// markup out) so the landing page mock renders the same button as CategoryStrip.

import type { ComponentProps, CSSProperties, ReactNode } from 'react';
import { Button } from '@/shared/components/ui/button';
import { Kbd } from '@/shared/components/ui/kbd';

const CAT_TILE =
  'min-h-(--h-ctl) min-w-0 max-w-full gap-2 whitespace-normal py-1.5 pr-3 pl-2 text-left';

export function LogButton({
  hotkey,
  color,
  label,
  srName,
  latched,
  ...props
}: Omit<ComponentProps<typeof Button>, 'variant' | 'size' | 'className' | 'style' | 'children'> & {
  /** 1–9, shown as a key cap; omitted past the ninth button. */
  hotkey?: number;
  /** The category colour (user data): swatch, hover edge and latched tint only. */
  color: string;
  label: ReactNode;
  /** Category name read before a toggle's on/off label. */
  srName?: string;
  /** On/Off buttons: which state the toggle is in. */
  latched?: 'on' | 'off';
}) {
  return (
    <Button
      variant="log"
      size={null}
      className={CAT_TILE}
      style={{ '--cat': color } as CSSProperties}
      data-latched={latched}
      {...props}
    >
      <span className="flex items-center gap-2" aria-hidden="true">
        {hotkey !== undefined && <Kbd>{hotkey}</Kbd>}
        <span className="size-2 shrink-0 rounded-[2px] bg-(--cat)" />
      </span>
      <span className="min-w-0 break-words leading-tight">
        {srName !== undefined && <span className="sr-only">{srName}: </span>}
        {label}
      </span>
    </Button>
  );
}
