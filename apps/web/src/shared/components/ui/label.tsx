import type * as React from 'react';
import { cn } from '@/shared/lib/utils';

// base-nova (job 088): Base UI has no Label primitive, so this is the native <label>.
function Label({ className, ...props }: React.ComponentProps<'label'>) {
  return (
    // biome-ignore lint/a11y/noLabelWithoutControl: the caller associates it (htmlFor or nesting).
    <label
      data-slot="label"
      className={cn(
        'flex items-center gap-2 text-[0.8rem] leading-snug text-v5-muted select-none group-data-[disabled=true]:pointer-events-none group-data-[disabled=true]:opacity-50 peer-disabled:cursor-not-allowed peer-disabled:opacity-50',
        className,
      )}
      {...props}
    />
  );
}

export { Label };
