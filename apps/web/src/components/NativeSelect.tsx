import type { SelectHTMLAttributes } from 'react';
import { cn } from '@/shared/lib/utils';

// The chevron as one class token (spaces percent-encoded): a space inside an arbitrary value splits
// the class, so Tailwind never generated it. The position is labelled (`bg-[position:…]`) because
// tailwind-merge reads a bare `bg-[right_…]` as a colour and would drop `bg-(--si-bg)`.
const CHEVRON =
  'bg-[url(data:image/svg+xml,%3Csvg%20xmlns=%27http://www.w3.org/2000/svg%27%20viewBox=%270%200%2024%2024%27%20fill=%27none%27%20stroke=%27%23a6acb7%27%20stroke-width=%272%27%20stroke-linecap=%27round%27%20stroke-linejoin=%27round%27%3E%3Cpath%20d=%27m6%209%206%206%206-6%27/%3E%3C/svg%3E)]';

/** A native <select> wearing the app's Select trigger face (robust on phones and in forms). */
export function NativeSelect({
  className,
  children,
  ...props
}: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select
      className={cn(
        'w-full min-h-(--h-ctl) cursor-pointer appearance-none rounded-ctl border border-input bg-(--si-bg) bg-[length:0.9rem] bg-[position:right_0.6rem_center] bg-no-repeat py-2 pr-8 pl-3 text-[0.85rem] leading-[1.2] text-si-fg outline-none [font-family:inherit] hover-always:not-disabled:border-si-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-si-accent disabled:cursor-not-allowed disabled:opacity-50',
        CHEVRON,
        className,
      )}
      {...props}
    >
      {children}
    </select>
  );
}
