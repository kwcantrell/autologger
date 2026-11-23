import { Radio as RadioPrimitive } from '@base-ui/react/radio';
import { RadioGroup as RadioGroupPrimitive } from '@base-ui/react/radio-group';
import { cn } from '@/shared/lib/utils';

function RadioGroup({ className, ...props }: RadioGroupPrimitive.Props) {
  return (
    <RadioGroupPrimitive
      data-slot="radio-group"
      className={cn('grid gap-3', className)}
      {...props}
    />
  );
}

// base-nova radio shape (the indicator is a plain dot, not an icon) with the Show Ignition look
// kept: a hairline ring on the input well, and an accent dot when checked (the registry fills the
// whole radio with the primary colour instead). The dot is 7.33px, the painted size of the
// lucide circle it replaces. The registry's enlarged invisible hit area (`after:-inset-*`) is
// left out: the event-button colour swatches are radios 8px apart, and overlapping hit areas
// would steal each other's clicks.
function RadioGroupItem({ className, ...props }: RadioPrimitive.Root.Props) {
  return (
    <RadioPrimitive.Root
      data-slot="radio-group-item"
      className={cn(
        'aspect-square size-4 shrink-0 rounded-full border border-input text-primary shadow-xs transition-[color,box-shadow] outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 data-disabled:cursor-not-allowed data-disabled:opacity-50 aria-invalid:border-destructive bg-input/30 aria-invalid:ring-destructive/40',
        className,
      )}
      {...props}
    >
      <RadioPrimitive.Indicator
        data-slot="radio-group-indicator"
        className="relative flex size-full items-center justify-center"
      >
        <span className="absolute top-1/2 left-1/2 size-[0.458rem] -translate-x-1/2 -translate-y-1/2 rounded-full bg-primary" />
      </RadioPrimitive.Indicator>
    </RadioPrimitive.Root>
  );
}

export { RadioGroup, RadioGroupItem };
