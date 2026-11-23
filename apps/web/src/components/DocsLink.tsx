// An inline link from the app to a documentation page (see lib/docsLinks). It opens in a new tab,
// so reading the docs never closes the dialog or panel the link sits in.

import type { ReactNode } from 'react';
import { useDocsHref } from '@/lib/docsLinks';
import { cn } from '@/shared/lib/utils';

export function DocsLink({
  page,
  className,
  children,
}: {
  /** '<section>/<slug>' (DOC_PAGES), '' for the docs home. */
  page: string;
  className?: string;
  children: ReactNode;
}) {
  const href = useDocsHref()(page);
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className={cn('text-si-fg underline underline-offset-4 hover:text-si-accent', className)}
    >
      {children}
    </a>
  );
}
