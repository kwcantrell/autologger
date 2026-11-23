// The block-level "couldn't load this" panel inside a page or feed: an Alert with a short title,
// the server's message and a Try again button. Props in, markup out. One-line inline errors
// (a row's failed undo, a form field) stay plain text.

import { CircleHelpIcon, TriangleAlertIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { Alert, AlertDescription, AlertTitle } from '@/shared/components/ui/alert';
import { Button, TOUCH_TARGET } from '@/shared/components/ui/button';
import { cn } from '@/shared/lib/utils';

export function LoadErrorAlert({
  title,
  children,
  onRetry,
  retrying = false,
  missing = false,
  className,
}: {
  title: ReactNode;
  /** The explanation, usually `errorMessage(error)`. */
  children?: ReactNode;
  /** Shows Try again; omit when retrying can't help (not found, no access). */
  onRetry?: () => void;
  retrying?: boolean;
  /** Not found / no access: a neutral panel instead of the danger one. */
  missing?: boolean;
  className?: string;
}) {
  return (
    <Alert variant={missing ? 'default' : 'destructive'} className={className}>
      {missing ? <CircleHelpIcon aria-hidden="true" /> : <TriangleAlertIcon aria-hidden="true" />}
      <AlertTitle>{title}</AlertTitle>
      {(children || onRetry) && (
        <AlertDescription className="gap-2">
          {children && <p className="m-0 [overflow-wrap:anywhere]">{children}</p>}
          {onRetry && (
            <Button
              variant="outline"
              className={cn('mt-1', TOUCH_TARGET)}
              disabled={retrying}
              onClick={onRetry}
            >
              {retrying ? 'Retrying…' : 'Try again'}
            </Button>
          )}
        </AlertDescription>
      )}
    </Alert>
  );
}
