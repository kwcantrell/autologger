import { type ClassValue, clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';

/** Joins class names and resolves conflicting Tailwind utilities (later wins). The shadcn primitives' `cn`. */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}

/**
 * A hit area of at least 44×44 px around a smaller control (DESIGN.md: "Phone controls keep a
 * 44px touch floor"), drawn by a transparent ::after centred on it, on phones and on any touch
 * screen; mouse users at desktop widths keep the control's own box. The visual size is
 * unchanged. The control must be positioned (`relative` or `absolute`).
 */
export const TOUCH_HIT =
  'after:absolute after:top-1/2 after:left-1/2 after:h-[max(100%,2.75rem)] after:w-[max(100%,2.75rem)] after:-translate-x-1/2 after:-translate-y-1/2 md:pointer-fine:after:hidden';
