import { Input as InputPrimitive } from '@base-ui/react/input';
import type * as React from 'react';
import { cn } from '@/shared/lib/utils';

// V5 (shadcn-port-shell D1): base strings replaced with the legacy form vocabulary
// (.profile-select / .field / .modal-hint), so ported forms match unported ones.
// `variant="unstyled"` (job 090): an inline cell editor that takes its cell's face (the feed rows'
// inline inputs, the timeline zoom readout). No base string; the caller's class string is applied
// verbatim, so the field renders exactly as its own classes say, with the primitive's semantics.
function Input({
  className,
  type,
  variant = 'default',
  ...props
}: React.ComponentProps<'input'> & { variant?: 'default' | 'unstyled' }) {
  if (variant === 'unstyled') {
    return (
      <InputPrimitive
        type={type}
        data-slot="input"
        data-variant="unstyled"
        className={className}
        {...props}
      />
    );
  }
  return (
    <InputPrimitive
      type={type}
      data-slot="input"
      className={cn(
        'w-full min-w-0 rounded-ctl border border-input bg-(--si-bg) px-[0.65rem] py-2 text-foreground h-(--h-ctl) outline-none transition-[border-color,background] duration-150 placeholder:text-muted-foreground disabled:cursor-not-allowed disabled:opacity-50 focus-visible:border-ring aria-invalid:border-destructive',
        className,
      )}
      {...props}
    />
  );
}

export { Input };
