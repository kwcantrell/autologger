import type { SelectHTMLAttributes } from 'react';
import { cn } from '@/shared/lib/utils';

/** A native <select> wearing the app's Select trigger face (robust on phones and in forms). */
export function NativeSelect({
  className,
  children,
  ...props
}: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select
      className={cn(
        'w-full min-h-(--h-ctl) cursor-pointer appearance-none rounded-ctl border border-input bg-(--si-bg) bg-[length:0.9rem] bg-[right_0.6rem_center] bg-no-repeat py-2 pr-8 pl-3 text-[0.85rem] leading-[1.2] text-si-fg outline-none [font-family:inherit] hover-always:not-disabled:border-si-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-si-accent disabled:cursor-not-allowed disabled:opacity-50',
        "bg-[url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%23a6acb7' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='m6 9 6 6 6-6'/%3E%3C/svg%3E\")]",
        className,
      )}
      {...props}
    >
      {children}
    </select>
  );
}
