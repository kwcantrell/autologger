// The top bar's search: a ghost icon trigger (tooltip "Search ⌘K"), the global ⌘/Ctrl-K shortcut
// and the command palette dialog. The palette's contents (cmdk) load on first open.

import { SearchIcon } from 'lucide-react';
import { lazy, Suspense, useEffect } from 'react';
import { ErrorBoundary } from '@/components/ErrorBoundary';
import { isTypingTarget, MOD_KEY_LABEL } from '@/lib/keys';
import { paletteOpen, useStore } from '@/lib/store';
import { Button } from '@/shared/components/ui/button';
import { Dialog, DialogContent, DialogTitle } from '@/shared/components/ui/dialog';
import { Kbd, KbdGroup } from '@/shared/components/ui/kbd';
import { Spinner } from '@/shared/components/ui/spinner';
import { isOverlayOpen } from '@/shared/ui/overlayOpen';
import { Tooltip } from '@/shared/ui/Tooltip';

const PaletteBody = lazy(() => import('./PaletteBody').then((m) => ({ default: m.PaletteBody })));

export function SearchPalette() {
  const open = useStore(paletteOpen);
  const setOpen = (v: boolean) => paletteOpen.set(v);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() !== 'k' || !(e.metaKey || e.ctrlKey)) return;
      if (e.altKey || e.shiftKey || e.defaultPrevented) return;
      if (isTypingTarget(e.target) || isOverlayOpen(document)) return;
      e.preventDefault();
      paletteOpen.set(true);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  return (
    <>
      <Tooltip
        side="bottom"
        content={
          <span className="inline-flex items-center gap-2">
            Search
            <KbdGroup>
              <Kbd>{MOD_KEY_LABEL}</Kbd>
              <Kbd>K</Kbd>
            </KbdGroup>
          </span>
        }
      >
        <Button
          variant="ghost"
          size="icon"
          aria-label="Search"
          className="size-(--h-ctl) shrink-0"
          onClick={() => setOpen(true)}
        >
          <SearchIcon />
        </Button>
      </Tooltip>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent
          aria-describedby={undefined}
          className="top-[12vh] w-[min(100%_-_2rem,38rem)] ![transform:translate(-50%,0)] overflow-hidden p-0"
        >
          <DialogTitle className="sr-only">Search</DialogTitle>
          {open && (
            <ErrorBoundary>
              <Suspense
                fallback={
                  <div role="status" className="flex justify-center px-3 py-6 text-si-muted">
                    <Spinner aria-label="Loading search" />
                  </div>
                }
              >
                <PaletteBody onDone={() => setOpen(false)} />
              </Suspense>
            </ErrorBoundary>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}
