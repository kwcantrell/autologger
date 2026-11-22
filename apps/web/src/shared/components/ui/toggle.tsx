
import { Toggle as TogglePrimitive } from '@base-ui/react/toggle';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/shared/lib/utils';

const toggleVariants = cva(
  "inline-flex items-center justify-center gap-2 rounded-ctl font-ui text-[0.8125rem] font-semibold whitespace-nowrap text-muted-foreground transition-[color,background-color,box-shadow] outline-none hover:bg-accent hover:text-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-50 aria-invalid:border-destructive data-pressed:bg-(--sel-bg) data-pressed:shadow-[inset_0_0_0_1px_var(--sel-line)] data-pressed:text-foreground aria-invalid:ring-destructive/40 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        default: 'bg-transparent',
        outline:
          'border border-input bg-transparent shadow-xs hover:bg-accent hover:text-accent-foreground',
      },
      size: {
        default: 'h-(--h-sm) min-w-(--h-sm) px-2',
        sm: 'h-8 min-w-8 px-1.5',
        lg: 'h-(--h-ctl) min-w-(--h-ctl) px-2.5',
      },
    },
    defaultVariants: {
      variant: 'default',
      size: 'default',
    },
  },
);

function Toggle({
  className,
  variant,
  size,
  ...props
}: TogglePrimitive.Props & VariantProps<typeof toggleVariants>) {
  return (
    <TogglePrimitive
      data-slot="toggle"
      className={cn(toggleVariants({ variant, size, className }))}
      {...props}
    />
  );
}

export { Toggle, toggleVariants };
