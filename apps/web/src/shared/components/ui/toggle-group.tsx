import { Toggle as TogglePrimitive } from '@base-ui/react/toggle';
import { ToggleGroup as ToggleGroupPrimitive } from '@base-ui/react/toggle-group';
import type { VariantProps } from 'class-variance-authority';
import * as React from 'react';
import { toggleVariants } from '@/shared/components/ui/toggle';
import { cn } from '@/shared/lib/utils';

const ToggleGroupContext = React.createContext<
  VariantProps<typeof toggleVariants> & {
    spacing?: number;
    multiple?: boolean;
  }
>({
  size: 'default',
  variant: 'default',
  spacing: 0,
  multiple: false,
});

// base-nova (job 088): Base UI ToggleGroup; `value` is always an array and `multiple` replaces
// Radix's `type`. Items are Base UI Toggles (`data-pressed` marks the selected one). A single-choice
// group keeps the radio semantics the Radix single toggle group had (role="radiogroup" with
// role="radio" / aria-checked items) instead of Base UI's pressed buttons.
function ToggleGroup({
  className,
  variant,
  size,
  spacing = 0,
  multiple = false,
  children,
  ...props
}: ToggleGroupPrimitive.Props &
  VariantProps<typeof toggleVariants> & {
    spacing?: number;
  }) {
  return (
    <ToggleGroupPrimitive
      data-slot="toggle-group"
      data-variant={variant}
      data-size={size}
      data-spacing={spacing}
      role={multiple ? undefined : 'radiogroup'}
      multiple={multiple}
      style={{ '--gap': spacing } as React.CSSProperties}
      className={cn(
        'group/toggle-group flex w-fit items-center gap-[--spacing(var(--gap))] rounded-md data-[spacing=default]:data-[variant=outline]:shadow-xs',
        className,
      )}
      {...props}
    >
      <ToggleGroupContext.Provider value={{ variant, size, spacing, multiple }}>
        {children}
      </ToggleGroupContext.Provider>
    </ToggleGroupPrimitive>
  );
}

function ToggleGroupItem({
  className,
  children,
  variant,
  size,
  ...props
}: TogglePrimitive.Props & VariantProps<typeof toggleVariants>) {
  const context = React.useContext(ToggleGroupContext);

  return (
    <TogglePrimitive
      data-slot="toggle-group-item"
      data-variant={context.variant || variant}
      data-size={context.size || size}
      data-spacing={context.spacing}
      className={cn(
        toggleVariants({
          variant: context.variant || variant,
          size: context.size || size,
        }),
        'w-auto min-w-0 shrink-0 px-3 focus:z-10 focus-visible:z-10',
        'data-[spacing=0]:rounded-none data-[spacing=0]:shadow-none data-[spacing=0]:first:rounded-l-md data-[spacing=0]:last:rounded-r-md data-[spacing=0]:data-[variant=outline]:border-l-0 data-[spacing=0]:data-[variant=outline]:first:border-l',
        className,
      )}
      render={
        context.multiple
          ? undefined
          : ({ 'aria-pressed': _pressed, ...renderProps }, state) => (
              // biome-ignore lint/a11y/useSemanticElements: a toggle button in a single-choice group, exposed as a radio like the Radix group it replaces (no native radio is involved).
              <button {...renderProps} type="button" role="radio" aria-checked={state.pressed} />
            )
      }
      {...props}
    >
      {children}
    </TogglePrimitive>
  );
}

export { ToggleGroup, ToggleGroupItem };
