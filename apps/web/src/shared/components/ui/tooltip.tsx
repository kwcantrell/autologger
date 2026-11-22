import { Tooltip as TooltipPrimitive } from '@base-ui/react/tooltip';
import { cn } from '@/shared/lib/utils';

function TooltipProvider({ delay = 0, ...props }: TooltipPrimitive.Provider.Props) {
  return <TooltipPrimitive.Provider data-slot="tooltip-provider" delay={delay} {...props} />;
}

function Tooltip({ ...props }: TooltipPrimitive.Root.Props) {
  return <TooltipPrimitive.Root data-slot="tooltip" {...props} />;
}

function TooltipTrigger({ ...props }: TooltipPrimitive.Trigger.Props) {
  return <TooltipPrimitive.Trigger data-slot="tooltip-trigger" {...props} />;
}

// V5 (shadcn-shared-wrappers D1): base strings replaced with the legacy wrapper classes. base-nova
// (job 088): Portal > Positioner > Popup; the positioning props are forwarded to the Positioner.
// Base UI's Arrow is a box, so the legacy 10x5 caret is drawn as an SVG inside it and turned to
// face the trigger on each side.
function TooltipContent({
  className,
  side = 'top',
  sideOffset = 0,
  align = 'center',
  alignOffset = 0,
  children,
  ...props
}: TooltipPrimitive.Popup.Props &
  Pick<TooltipPrimitive.Positioner.Props, 'align' | 'alignOffset' | 'side' | 'sideOffset'>) {
  return (
    <TooltipPrimitive.Portal>
      <TooltipPrimitive.Positioner
        align={align}
        alignOffset={alignOffset}
        side={side}
        sideOffset={sideOffset}
        className="isolate z-(--z-top-float)"
      >
        <TooltipPrimitive.Popup
          data-slot="tooltip-content"
          // Base UI leaves the popup without a role; the app's tooltips were (and stay) role=tooltip.
          role="tooltip"
          className={cn(
            'z-(--z-top-float) max-w-[22rem] origin-(--transform-origin) rounded-v5-sm border border-v5-border-strong bg-si-panel-2 px-[0.6rem] py-[0.4rem] text-[0.78rem] text-v5-text leading-[1.35] animate-tooltip-fade-in',
            className,
          )}
          {...props}
        >
          {children}
          <TooltipPrimitive.Arrow className="flex h-[5px] w-[10px] data-[side=bottom]:bottom-full data-[side=bottom]:rotate-180 data-[side=left]:left-full data-[side=left]:-rotate-90 data-[side=right]:right-full data-[side=right]:rotate-90 data-[side=top]:top-full">
            <svg
              aria-hidden="true"
              width="10"
              height="5"
              viewBox="0 0 30 10"
              preserveAspectRatio="none"
              className="block fill-si-panel-2 stroke-v5-border-strong"
            >
              <polygon points="0,0 30,0 15,10" />
            </svg>
          </TooltipPrimitive.Arrow>
        </TooltipPrimitive.Popup>
      </TooltipPrimitive.Positioner>
    </TooltipPrimitive.Portal>
  );
}

export { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger };
