// The right-hand sheet Settings edits one thing in (a member, a show, an event button). Dirtiness
// is derived from the draft vs the snapshot at open; every close with unsaved changes confirms.
// Save runs the caller's `onSave` and closes on success; on failure the sheet stays open and names
// the step that did not apply.

import { type ReactNode, useCallback, useState } from 'react';
import { errorMessage } from '@/api/rpc';
import { Alert, AlertDescription } from '@/shared/components/ui/alert';
import { Button } from '@/shared/components/ui/button';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from '@/shared/components/ui/sheet';
import { Spinner } from '@/shared/components/ui/spinner';
import { useConfirm } from '@/shared/ui/ConfirmDialog';

export class SaveStepError extends Error {
  constructor(step: string, detail: string) {
    super(`Couldn’t ${step}: ${detail}`);
    this.name = 'SaveStepError';
  }
}

export interface SaveStep {
  label: string;
  run: () => unknown;
}

/** Run calls in order, stopping at the first failure with an error naming the step. */
export async function runSaveSteps(steps: readonly SaveStep[]): Promise<void> {
  for (const step of steps) {
    try {
      await step.run();
    } catch (err) {
      throw new SaveStepError(step.label, errorMessage(err));
    }
  }
}

export interface SidePanelState<T> {
  id: T;
  open: boolean;
  /** Bumped on every open: key the panel with it so each open starts a fresh draft. */
  n: number;
}

export function useSidePanel<T>() {
  const [panel, setPanel] = useState<SidePanelState<T> | null>(null);
  const openPanel = useCallback(
    (id: T) => setPanel((p) => ({ id, open: true, n: (p?.n ?? 0) + 1 })),
    [],
  );
  const closePanel = useCallback(() => setPanel((p) => (p ? { ...p, open: false } : p)), []);
  return { panel, openPanel, closePanel };
}

export function SidePanel<T>({
  open,
  onClose,
  title,
  description,
  media,
  value,
  baseline,
  valid = true,
  onSave,
  saveLabel = 'Save',
  children,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: ReactNode;
  media?: ReactNode;
  value: T;
  baseline?: T;
  valid?: boolean;
  onSave: () => Promise<void>;
  saveLabel?: string;
  children: ReactNode;
}) {
  const serialized = JSON.stringify(value);
  const [snapshot, setSnapshot] = useState(() => (open ? serialized : null));
  const [prevOpen, setPrevOpen] = useState(open);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (open !== prevOpen) {
    setPrevOpen(open);
    if (open) {
      setSnapshot(serialized);
      setError(null);
    }
  }
  const reference = baseline !== undefined ? JSON.stringify(baseline) : snapshot;
  const dirty = reference !== null && serialized !== reference;
  const { confirm, confirmElement } = useConfirm();

  async function requestClose() {
    if (saving) return;
    if (dirty) {
      const ok = await confirm({
        title: 'Discard changes?',
        message: `Your changes to ${title.toLowerCase()} haven’t been saved. Discard them?`,
        confirmLabel: 'Discard',
        cancelLabel: 'Keep editing',
        danger: true,
      });
      if (!ok) return;
    }
    onClose();
  }

  async function handleSave() {
    setSaving(true);
    setError(null);
    try {
      await onSave();
      onClose();
    } catch (err) {
      setError(err instanceof SaveStepError ? err.message : `Couldn’t save: ${errorMessage(err)}`);
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <Sheet
        open={open}
        onOpenChange={(next) => {
          if (!next) void requestClose();
        }}
      >
        <SheetContent side="right" className="w-full gap-0 sm:max-w-[420px]">
          <SheetHeader className="flex-row items-center gap-3 pr-12">
            {media}
            <div className="flex min-w-0 flex-col gap-1">
              <SheetTitle className="truncate">{title}</SheetTitle>
              {description && <SheetDescription>{description}</SheetDescription>}
            </div>
          </SheetHeader>
          <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-4 pb-4">
            {children}
          </div>
          <SheetFooter className="mt-0 border-t border-(--si-line)">
            {error && (
              <Alert variant="destructive">
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            )}
            <div data-slot="side-panel-actions" className="flex justify-end gap-2">
              <Button variant="outline" disabled={saving} onClick={() => void requestClose()}>
                Cancel
              </Button>
              <Button disabled={!dirty || !valid || saving} onClick={() => void handleSave()}>
                {saving && <Spinner data-icon="inline-start" />}
                {saveLabel}
              </Button>
            </div>
          </SheetFooter>
        </SheetContent>
      </Sheet>
      {confirmElement}
    </>
  );
}
