import { cva, type VariantProps } from 'class-variance-authority';
import type * as React from 'react';
import { Button } from '@/shared/components/ui/button';
import { Input } from '@/shared/components/ui/input';
import { Textarea } from '@/shared/components/ui/textarea';
import { cn } from '@/shared/lib/utils';

// base-nova input-group in the Show Ignition vocabulary: the group wears the Input's well (ground
// fill, strong-hairline edge, 8px corners, --h-ctl tall) and its control goes bare inside it, so a
// search field with a leading icon or a trailing clear button reads as one field. Focus follows
// the Input: the edge turns accent on keyboard focus of the control, no ring. Local edits:
// inline addons keep the same 12px inset from the outer edge as the hand-positioned icons they
// replace (11px inside the 1px edge, 5px when the addon is a button), so swapping one in is
// pixel-equivalent; the registry's negative-margin button nudges are dropped.
function InputGroup({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    // biome-ignore lint/a11y/useSemanticElements: shadcn InputGroup is a div group by design; a fieldset would add min-content sizing and a border reset to every search field.
    <div
      data-slot="input-group"
      role="group"
      className={cn(
        'group/input-group relative flex h-(--h-ctl) w-full min-w-0 items-center rounded-ctl border border-input bg-(--si-bg) text-foreground outline-none transition-[border-color,background] duration-150',
        'has-[[data-slot=input-group-control]:focus-visible]:border-ring',
        'has-[[data-slot][aria-invalid=true]]:border-destructive',
        'has-disabled:opacity-50',
        'has-[>textarea]:h-auto has-[>[data-align=block-end]]:h-auto has-[>[data-align=block-end]]:flex-col has-[>[data-align=block-start]]:h-auto has-[>[data-align=block-start]]:flex-col',
        'has-[>[data-align=inline-start]]:[&>input]:pl-[0.5625rem] has-[>[data-align=inline-end]]:[&>input]:pr-1.5 has-[>[data-align=block-start]]:[&>input]:pb-3 has-[>[data-align=block-end]]:[&>input]:pt-3',
        className,
      )}
      {...props}
    />
  );
}

const inputGroupAddonVariants = cva(
  "flex h-auto cursor-text items-center justify-center gap-2 py-1.5 text-sm font-medium text-muted-foreground select-none [&>svg:not([class*='size-'])]:size-4 [&>svg]:pointer-events-none [&>svg]:shrink-0",
  {
    variants: {
      align: {
        'inline-start': 'order-first pl-[0.6875rem] has-[>button]:pl-[0.3125rem]',
        'inline-end': 'order-last pr-[0.6875rem] has-[>button]:pr-[0.3125rem]',
        'block-start':
          'order-first w-full justify-start px-[0.65rem] pt-2 group-has-[>input]/input-group:pt-2 [.border-b]:pb-2',
        'block-end':
          'order-last w-full justify-start px-[0.65rem] pb-2 group-has-[>input]/input-group:pb-2 [.border-t]:pt-2',
      },
    },
    defaultVariants: {
      align: 'inline-start',
    },
  },
);

function InputGroupAddon({
  className,
  align = 'inline-start',
  ...props
}: React.ComponentProps<'div'> & VariantProps<typeof inputGroupAddonVariants>) {
  return (
    // Clicking the icon or label beside the field focuses the field (a pointer convenience; the
    // field itself is the keyboard target).
    // biome-ignore lint/a11y/useSemanticElements: the registry's addon group, a div so it can sit inside the field's flex row.
    // biome-ignore lint/a11y/useKeyWithClickEvents: keyboard users tab to the field itself.
    <div
      role="group"
      data-slot="input-group-addon"
      data-align={align}
      className={cn(inputGroupAddonVariants({ align }), className)}
      onClick={(e) => {
        if ((e.target as HTMLElement).closest('button')) return;
        e.currentTarget.parentElement?.querySelector('input')?.focus();
      }}
      {...props}
    />
  );
}

// A button inside the field (clear, copy, submit): the shadcn Button, ghost and extra-small by
// default, so it sits inside the 36px well.
function InputGroupButton({
  className,
  type = 'button',
  variant = 'ghost',
  size = 'xs',
  ...props
}: Omit<React.ComponentProps<typeof Button>, 'type'> & {
  type?: 'button' | 'submit' | 'reset';
}) {
  return (
    <Button
      type={type}
      variant={variant}
      size={size}
      className={cn('shadow-none', className)}
      {...props}
    />
  );
}

function InputGroupText({ className, ...props }: React.ComponentProps<'span'>) {
  return (
    <span
      className={cn(
        "flex items-center gap-2 text-sm text-muted-foreground [&_svg]:pointer-events-none [&_svg:not([class*='size-'])]:size-4",
        className,
      )}
      {...props}
    />
  );
}

// The bare control: the Input's type and padding, none of its well (the group draws that). It
// fills the group's height inside the 1px edge, so its text sits where a lone Input's does.
function InputGroupInput({ className, ...props }: React.ComponentProps<typeof Input>) {
  return (
    <Input
      data-slot="input-group-control"
      className={cn(
        'h-full flex-1 rounded-none border-0 bg-transparent shadow-none focus-visible:border-0 disabled:bg-transparent disabled:opacity-100 aria-invalid:border-0',
        className,
      )}
      {...props}
    />
  );
}

function InputGroupTextarea({ className, ...props }: React.ComponentProps<typeof Textarea>) {
  return (
    <Textarea
      data-slot="input-group-control"
      className={cn(
        'flex-1 resize-none rounded-none border-0 bg-transparent py-2 shadow-none focus-visible:border-0 disabled:bg-transparent disabled:opacity-100 aria-invalid:border-0',
        className,
      )}
      {...props}
    />
  );
}

export {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
  InputGroupText,
  InputGroupTextarea,
};
