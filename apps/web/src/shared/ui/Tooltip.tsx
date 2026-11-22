import { isValidElement, type ReactElement, type ReactNode } from 'react';
import {
  TooltipContent,
  TooltipProvider as TooltipProviderPrimitive,
  Tooltip as TooltipRoot,
  TooltipTrigger,
} from '@/shared/components/ui/tooltip';

interface TooltipProps {
  content: ReactNode;
  children: ReactNode;
  side?: 'top' | 'right' | 'bottom' | 'left';
  align?: 'start' | 'center' | 'end';
  sideOffset?: number;
  /** Hover delay before opening, in ms (the primitive trigger's `delay`). */
  delayDuration?: number;
  /** Render the child itself as the trigger (default). `false` wraps it in the primitive's own
   *  trigger button instead — used when the child is not a single element. */
  asChild?: boolean;
  disabled?: boolean;
  className?: string;
}

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

export function Tooltip({
  content,
  children,
  side = 'top',
  align = 'center',
  sideOffset = 6,
  delayDuration,
  asChild = true,
  disabled = false,
  className,
}: TooltipProps) {
  if (disabled) return <>{children}</>;
  // shadcn-shared-wrappers D5: the V5 surface + arrow live in the shadcn primitive (D1). job 088:
  // the Base UI trigger renders the child through `render` (Radix's `asChild`).
  const render = asChild && isValidElement(children) ? (children as ReactElement) : undefined;
  return (
    <TooltipRoot>
      <TooltipTrigger delay={delayDuration} render={render}>
        {render ? undefined : children}
      </TooltipTrigger>
      <TooltipContent side={side} align={align} sideOffset={sideOffset} className={className}>
        {content}
      </TooltipContent>
    </TooltipRoot>
  );
}
