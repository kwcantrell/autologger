import { Tooltip as TooltipPrimitive } from '@base-ui/react/tooltip';
import { cloneElement, isValidElement, type ReactElement, type ReactNode } from 'react';
import {
  TooltipContent,
  TooltipProvider as TooltipProviderPrimitive,
  Tooltip as TooltipRoot,
  TooltipTrigger,
} from '@/shared/components/ui/tooltip';

type Side = 'top' | 'right' | 'bottom' | 'left';
type Align = 'start' | 'center' | 'end';

interface TooltipProps {
  content: ReactNode;
  children: ReactNode;
  side?: Side;
  align?: Align;
  sideOffset?: number;
  /** Hover delay before opening, in ms (the primitive trigger's `delay`). */
  delayDuration?: number;
  /** Render the child itself as the trigger (default). `false` wraps it in the primitive's own
   *  trigger button instead — used when the child is not a single element. */
  asChild?: boolean;
  disabled?: boolean;
  /** Use the one tooltip shared by list rows (see `TooltipHost`) instead of a tooltip of its own.
   *  For controls repeated per row of a long list (jump, delete, undo, markers): each row then
   *  carries only a trigger. `className` does not apply. */
  shared?: boolean;
  /** While `disabled`, put `content` (a string) on the child's native `title` instead: for a
   *  button that is itself disabled, which gets no pointer or focus events. */
  titleWhenDisabled?: boolean;
  className?: string;
}

interface SharedPayload {
  content: ReactNode;
  side: Side;
  align: Align;
  sideOffset: number;
}

const sharedTooltip = TooltipPrimitive.createHandle<SharedPayload>();

/** Wrap once at the page root (IndexRoot passes delayDuration={400}). `delayDuration` is the
 *  app-wide hover delay, the primitive provider's `delay`. */
export function TooltipProvider({
  delayDuration,
  children,
}: {
  delayDuration?: number;
  children: ReactNode;
}) {
  return <TooltipProviderPrimitive delay={delayDuration}>{children}</TooltipProviderPrimitive>;
}

/** The popup of the shared list-row tooltip (`<Tooltip shared>`). Mounted once, in App. */
export function TooltipHost() {
  return (
    <TooltipRoot handle={sharedTooltip as TooltipPrimitive.Handle<unknown>}>
      {({ payload }) => {
        const p = payload as SharedPayload | undefined;
        return p ? (
          <TooltipContent side={p.side} align={p.align} sideOffset={p.sideOffset}>
            {p.content}
          </TooltipContent>
        ) : null;
      }}
    </TooltipRoot>
  );
}

// Native `title` is still right in two places, and callers keep it there: on truncated text (it
// shows the full text) and on a disabled button (it gets no pointer or focus events, so a tooltip
// never opens). Everything interactive explains itself with this one, which also opens on
// keyboard focus and not on touch.
export function Tooltip({
  content,
  children,
  side = 'top',
  align = 'center',
  sideOffset = 6,
  delayDuration,
  asChild = true,
  disabled = false,
  shared = false,
  titleWhenDisabled = false,
  className,
}: TooltipProps) {
  const child =
    disabled && titleWhenDisabled && isValidElement(children) && typeof content === 'string'
      ? cloneElement(children as ReactElement<{ title?: string }>, { title: content })
      : children;
  // shadcn-shared-wrappers D5: the V5 surface + arrow live in the shadcn primitive (D1). job 088:
  // the Base UI trigger renders the child through `render` (Radix's `asChild`).
  const render = asChild && isValidElement(child) ? (child as ReactElement) : undefined;
  if (shared && render) {
    // Disabled keeps the trigger (no remount, so focus stays put when a row turns read-only).
    return (
      <TooltipTrigger
        handle={sharedTooltip}
        payload={{ content, side, align, sideOffset }}
        delay={delayDuration}
        disabled={disabled}
        render={render}
      />
    );
  }
  if (disabled) return <>{child}</>;
  return (
    <TooltipRoot>
      <TooltipTrigger delay={delayDuration} render={render}>
        {render ? undefined : child}
      </TooltipTrigger>
      <TooltipContent side={side} align={align} sideOffset={sideOffset} className={className}>
        {content}
      </TooltipContent>
    </TooltipRoot>
  );
}
