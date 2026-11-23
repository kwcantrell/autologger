// Edit a dashboard's spec as JSON. Validated locally with the contract's zod schema before save;
// server errors are shown inline too.

import { type Dashboard, DashboardSpec, formatIssues } from '@autologger/contract';
import { useMemo, useState } from 'react';
import { errorMessage } from '@/api/rpc';
import { useSessionMutation } from '@/api/session/writes';
import { showToast } from '@/shared/components/Toast';
import { Alert, AlertDescription } from '@/shared/components/ui/alert';
import { Button } from '@/shared/components/ui/button';
import { Textarea } from '@/shared/components/ui/textarea';
import { Dialog, DialogActions } from '@/shared/ui/Dialog';

type Check =
  | { ok: true; spec: DashboardSpec }
  | { ok: false; issues: { path: string; message: string }[] };

function check(text: string): Check {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (e) {
    return {
      ok: false,
      issues: [
        { path: '', message: `Invalid JSON: ${e instanceof Error ? e.message : String(e)}` },
      ],
    };
  }
  const r = DashboardSpec.safeParse(json);
  if (r.success) return { ok: true, spec: r.data };
  return {
    ok: false,
    issues: formatIssues(r.error.issues).slice(0, 20),
  };
}

export function SpecEditorDialog({
  dashboard,
  open,
  onClose,
}: {
  dashboard: Dashboard;
  open: boolean;
  onClose: () => void;
}) {
  return open ? (
    <Editor key={`${dashboard.id}-${dashboard.revision}`} dashboard={dashboard} onClose={onClose} />
  ) : null;
}

function Editor({ dashboard, onClose }: { dashboard: Dashboard; onClose: () => void }) {
  const [text, setText] = useState(() => JSON.stringify(dashboard.spec, null, 2));
  const result = useMemo(() => check(text), [text]);
  const save = useSessionMutation(dashboard.sessionId, 'dashboards.save');
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && !save.isPending && onClose()}
      title="Edit dashboard spec"
      description={`Revision ${dashboard.revision}. Saving replaces the whole spec.`}
      className="md:!max-w-[min(56rem,calc(100vw-2rem))]"
      closeOnOverlayClick={false}
    >
      <div className="flex flex-col gap-3">
        <Textarea
          aria-label="Dashboard spec JSON"
          spellCheck={false}
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            save.reset();
          }}
          aria-invalid={!result.ok || undefined}
          className="h-[55dvh] min-h-[12rem] resize-y font-tc text-[0.78rem] leading-[1.45] [field-sizing:fixed]"
        />
        {!result.ok && (
          <div
            role="alert"
            className="max-h-40 overflow-auto rounded-ctl border border-(--si-danger-line) p-2.5 text-[0.78rem] text-(--si-danger)"
          >
            <ul className="m-0 flex list-none flex-col gap-0.5 p-0">
              {result.issues.map((i, n) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: issues may repeat
                <li key={n}>
                  {i.path && <code className="mr-1.5 font-tc text-si-fg">{i.path}</code>}
                  {i.message}
                </li>
              ))}
            </ul>
          </div>
        )}
        {save.isError && (
          <Alert variant="destructive">
            <AlertDescription>Could not save: {errorMessage(save.error)}</AlertDescription>
          </Alert>
        )}
      </div>
      <DialogActions>
        <Button variant="outline" onClick={onClose} disabled={save.isPending}>
          Cancel
        </Button>
        <Button
          disabled={!result.ok || save.isPending}
          onClick={() => {
            if (!result.ok) return;
            save.mutate(
              { sessionId: dashboard.sessionId, dashboardId: dashboard.id, spec: result.spec },
              {
                onSuccess: () => {
                  showToast('Dashboard saved.');
                  onClose();
                },
              },
            );
          }}
        >
          {save.isPending ? 'Saving…' : 'Save'}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
