import { ChevronDownIcon } from 'lucide-react';
import type * as React from 'react';
import { cn } from '@/shared/lib/utils';

// base-nova native-select in the Show Ignition vocabulary: a real <select> (robust on phones and
// in forms) wearing the Select trigger's face — the ground well, the strong-hairline edge that
// turns accent on hover, the 8px control radius, --h-ctl tall (--h-sm for `size="sm"`), the
// keyboard focus outline. Local edits: the wrapper is full width (forms here stack full-width
// fields; the registry's is `w-fit`), and disabled keeps pointer events so `cursor-not-allowed`
// shows. Options take the well's colours, so the open list matches the field in every browser.
type NativeSelectProps = Omit<React.ComponentProps<'select'>, 'size'> & {
  size?: 'sm' | 'default';
};

function NativeSelect({ className, size = 'default', ...props }: NativeSelectProps) {
  return (
    <div
      className={cn(
        'group/native-select relative w-full min-w-0 has-[select:disabled]:opacity-50',
        className,
      )}
      data-slot="native-select-wrapper"
      data-size={size}
    >
      <select
        data-slot="native-select"
        data-size={size}
        className="w-full min-w-0 min-h-(--h-ctl) cursor-pointer appearance-none rounded-ctl border border-input bg-(--si-bg) py-2 pr-8 pl-3 text-[0.85rem] leading-[1.2] text-si-fg outline-none [font-family:inherit] hover-always:not-disabled:border-si-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-si-accent disabled:cursor-not-allowed aria-invalid:border-destructive data-[size=sm]:min-h-(--h-sm) data-[size=sm]:py-1"
        {...props}
      />
      <ChevronDownIcon
        className="pointer-events-none absolute top-1/2 right-[calc(0.6rem+1px)] size-[0.9rem] -translate-y-1/2 text-muted-foreground select-none"
        aria-hidden="true"
        data-slot="native-select-icon"
      />
    </div>
  );
}

function NativeSelectOption({ className, ...props }: React.ComponentProps<'option'>) {
  return (
    <option
      data-slot="native-select-option"
      className={cn('bg-(--si-bg) text-si-fg', className)}
      {...props}
    />
  );
}

function NativeSelectOptGroup({ className, ...props }: React.ComponentProps<'optgroup'>) {
  return (
    <optgroup
      data-slot="native-select-optgroup"
      className={cn('bg-(--si-bg) text-si-fg', className)}
      {...props}
    />
  );
}

export { NativeSelect, NativeSelectOptGroup, NativeSelectOption };
