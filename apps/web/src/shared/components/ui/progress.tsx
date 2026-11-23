import { Progress as ProgressPrimitive } from '@base-ui/react/progress';
import { cn } from '@/shared/lib/utils';

// base-nova progress (Base UI Progress) in the Show Ignition vocabulary: a 4px fully rounded
// track in the strong hairline with an accent fill — flat, no glow (glow means the transport is
// lit). The fill eases its width, instantly under reduced motion. Children (ProgressLabel,
// ProgressValue) sit on a row above the track.
function Progress({ className, children, value, ...props }: ProgressPrimitive.Root.Props) {
  return (
    <ProgressPrimitive.Root
      value={value}
      data-slot="progress"
      className={cn('flex flex-wrap gap-3', className)}
      {...props}
    >
      {children}
      <ProgressTrack>
        <ProgressIndicator />
      </ProgressTrack>
    </ProgressPrimitive.Root>
  );
}

function ProgressTrack({ className, ...props }: ProgressPrimitive.Track.Props) {
  return (
    <ProgressPrimitive.Track
      className={cn(
        'relative flex h-1 w-full items-center overflow-x-hidden rounded-full bg-(--si-line-strong)',
        className,
      )}
      data-slot="progress-track"
      {...props}
    />
  );
}

function ProgressIndicator({ className, ...props }: ProgressPrimitive.Indicator.Props) {
  return (
    <ProgressPrimitive.Indicator
      data-slot="progress-indicator"
      className={cn(
        'h-full bg-primary transition-[width] duration-150 motion-reduce:transition-none',
        className,
      )}
      {...props}
    />
  );
}

function ProgressLabel({ className, ...props }: ProgressPrimitive.Label.Props) {
  return (
    <ProgressPrimitive.Label
      className={cn('text-sm font-medium text-foreground', className)}
      data-slot="progress-label"
      {...props}
    />
  );
}

// The measured value: the measure face (JetBrains Mono, tabular figures), dim.
function ProgressValue({ className, ...props }: ProgressPrimitive.Value.Props) {
  return (
    <ProgressPrimitive.Value
      className={cn('ml-auto font-tc text-[0.75rem] tabular-nums text-si-dim', className)}
      data-slot="progress-value"
      {...props}
    />
  );
}

export { Progress, ProgressIndicator, ProgressLabel, ProgressTrack, ProgressValue };
