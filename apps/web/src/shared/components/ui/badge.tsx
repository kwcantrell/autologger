import { mergeProps } from '@base-ui/react/merge-props';
import { useRender } from '@base-ui/react/use-render';
import { cva, type VariantProps } from 'class-variance-authority';
import type * as React from 'react';
import { cn } from '@/shared/lib/utils';

const badgeVariants = cva(
  'inline-flex w-fit shrink-0 items-center justify-center gap-1 overflow-hidden rounded-[5px] border border-transparent font-label font-semibold uppercase tracking-[0.1em] whitespace-nowrap transition-[color,box-shadow] focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 aria-invalid:border-destructive [&>svg]:pointer-events-none [&>svg]:size-3 aria-invalid:ring-destructive/40',
  {
    variants: {
      variant: {
        default: 'bg-primary text-primary-foreground [a&]:hover:bg-primary/90',
        secondary: 'bg-secondary text-secondary-foreground [a&]:hover:bg-secondary/90',
        destructive:
          'text-white [a&]:hover:bg-destructive/90 bg-destructive/60 focus-visible:ring-destructive/40',
        outline:
          'border-v5-border-strong text-v5-muted [a&]:hover:bg-accent [a&]:hover:text-accent-foreground',
        ghost: '[a&]:hover:bg-accent [a&]:hover:text-accent-foreground',
        link: 'text-primary underline-offset-4 [a&]:hover:underline',
        // The transport status pill (redesign-show-ignition D10): STOPPED / ROLLING / REC / PLAY,
        // coloured from the shell's `data-transport` variables (`--tx-pill-*`, `--tx-glow`), so
        // it follows the same state as the tints. Every fg/bg pair clears AA (contrastTokens).
        transport:
          'border-(--tx-pill-line) bg-(--tx-pill-bg) text-(--tx-pill-fg) shadow-[0_0_18px_-4px_var(--tx-glow)] tracking-[0.14em]',
      },
      // `sm`: the compact tag inside dense rows (change-log actor and client tags, the dashboard
      // tab's "agent" mark).
      size: {
        default: 'px-[0.45rem] py-[0.2rem] text-[0.7rem]',
        sm: 'px-1 py-0 text-[0.6875rem]',
      },
    },
    defaultVariants: {
      variant: 'default',
      size: 'default',
    },
  },
);

// base-nova (job 088): `render` (Base UI useRender) replaces Radix's `asChild`.
function Badge({
  className,
  variant = 'default',
  size = 'default',
  render,
  ...props
}: useRender.ComponentProps<'span'> & VariantProps<typeof badgeVariants>) {
  return useRender({
    defaultTagName: 'span',
    render,
    props: mergeProps<'span'>(
      {
        'data-slot': 'badge',
        'data-variant': variant,
        'data-size': size,
        className: cn(badgeVariants({ variant, size }), className),
      } as React.ComponentProps<'span'>,
      props,
    ),
  });
}

export { Badge, badgeVariants };
