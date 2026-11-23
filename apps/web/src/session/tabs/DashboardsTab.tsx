// Dashboards tab: the session's agent-authored dashboards, rendered from their declarative spec.

import type { Dashboard, Session } from '@autologger/contract';
import { Braces, TriangleAlert } from 'lucide-react';
import { useState } from 'react';
import { qk, useDashboards, useOpMutation } from '@/api/queries';
import { errorMessage } from '@/api/rpc';
import { settingsOpen } from '@/lib/store';
import { useWorkspace } from '@/session/context';
import { SpecEditorDialog } from '@/session/dashboards/SpecEditor';
import { WidgetGrid } from '@/session/dashboards/widgets';
import {
  FEED_EMPTY,
  FeedShell,
  feedCountLabel,
  IconPencil,
  IconX,
  ToolbarCaption,
} from '@/session/feed';
import { showToast } from '@/shared/components/Toast';
import { Alert, AlertDescription } from '@/shared/components/ui/alert';
import { Badge } from '@/shared/components/ui/badge';
import { Button } from '@/shared/components/ui/button';
import { Tabs, TabsList, TabsTrigger } from '@/shared/components/ui/tabs';
import { cn } from '@/shared/lib/utils';
import { useConfirm } from '@/shared/ui/ConfirmDialog';
import { useTextPrompt } from '@/shared/ui/PromptDialog';

const DATE = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });
const fmtDate = (iso: string) => DATE.format(new Date(iso));

export function DashboardsTab({ session }: { session: Session }) {
  const { canWrite } = useWorkspace();
  const list = useDashboards(session.id);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const { confirm, confirmElement } = useConfirm();
  const { requestText, promptElement } = useTextPrompt();
  const save = useOpMutation('dashboards.save', {
    invalidate: (_d, i) => [qk.dashboards(i.sessionId)],
  });
  const del = useOpMutation('dashboards.delete', { invalidate: () => [qk.dashboards(session.id)] });

  const dashboards = list.data ?? [];
  const current = dashboards.find((d) => d.id === selectedId) ?? dashboards[0];

  const rename = async (d: Dashboard) => {
    const next = await requestText({
      title: 'Rename dashboard',
      label: 'Title',
      initialValue: d.title,
      submitLabel: 'Rename',
    });
    const title = next?.trim();
    if (!title || title === d.title) return;
    if (title.length > 200) {
      showToast('Titles can be at most 200 characters.', true);
      return;
    }
    save.mutate(
      { sessionId: d.sessionId, dashboardId: d.id, spec: { ...d.spec, title } },
      {
        onSuccess: () => showToast('Dashboard renamed.'),
        onError: (e) => showToast(`Rename failed: ${errorMessage(e)}`, true),
      },
    );
  };

  const remove = async (d: Dashboard) => {
    const ok = await confirm({
      title: 'Delete dashboard?',
      message: `“${d.title}” will be deleted for everyone on this show. You can undo it from the Agents tab.`,
      confirmLabel: 'Delete',
      danger: true,
    });
    if (!ok) return;
    del.mutate(
      { dashboardId: d.id },
      {
        onSuccess: () => {
          setSelectedId(null);
          showToast('Dashboard deleted.');
        },
        onError: (e) => showToast(`Delete failed: ${errorMessage(e)}`, true),
      },
    );
  };

  const toolbar =
    current && canWrite ? (
      <>
        <Button
          variant="glass"
          onClick={() => void rename(current)}
          disabled={save.isPending}
          title="Rename this dashboard"
        >
          <ToolbarCaption label="Rename" icon={<IconPencil />} />
        </Button>
        <Button
          variant="glass"
          onClick={() => setEditing(true)}
          title="Edit the dashboard spec as JSON"
        >
          <ToolbarCaption
            label="Edit JSON"
            icon={<Braces className="block size-[18px]" aria-hidden="true" />}
          />
        </Button>
        <Button
          variant="glass"
          onClick={() => void remove(current)}
          disabled={del.isPending}
          title="Delete this dashboard"
        >
          <ToolbarCaption label="Delete" icon={<IconX />} />
        </Button>
      </>
    ) : undefined;

  return (
    <FeedShell
      countLabel={list.isSuccess ? feedCountLabel(dashboards.length, 'dashboard') : 'Dashboards'}
      toolbar={toolbar}
    >
      {list.isPending ? (
        <div className={FEED_EMPTY}>Loading…</div>
      ) : list.isError ? (
        <Alert variant="destructive">
          <TriangleAlert aria-hidden="true" />
          <AlertDescription>
            Could not load the dashboards. {errorMessage(list.error)}
          </AlertDescription>
        </Alert>
      ) : !current ? (
        <div className={cn(FEED_EMPTY, 'flex flex-col items-center gap-3')}>
          <p className="m-0">
            No dashboards for this session yet. Agents create them over MCP — ask one to build a
            dashboard for this session.
          </p>
          <Button variant="outline" size="sm" onClick={() => settingsOpen.set('agents')}>
            Connect an agent
          </Button>
        </div>
      ) : (
        <div className="flex min-h-0 min-w-0 flex-col gap-3 overflow-y-auto md:max-h-[calc(100dvh-var(--topbar-h)-16rem)]">
          {!canWrite && (
            <p className="m-0 text-[0.78rem] text-si-muted">
              Read-only: you can view this show's dashboards.
            </p>
          )}
          {dashboards.length > 1 && (
            <DashboardTabs
              dashboards={dashboards}
              currentId={current.id}
              onSelect={setSelectedId}
            />
          )}
          <DashboardHeader dashboard={current} />
          <WidgetGrid widgets={current.spec.widgets} sessionId={session.id} />
        </div>
      )}
      {current && canWrite && (
        <SpecEditorDialog dashboard={current} open={editing} onClose={() => setEditing(false)} />
      )}
      {confirmElement}
      {promptElement}
    </FeedShell>
  );
}

// One line tab per dashboard (Tabs variant="line": arrow keys move between them). Dashboard
// titles are agent-written data, so the tabs keep the UI face in sentence case at 0.85rem rather
// than the uppercase tab type, and truncate at 16rem. `shrink-0`: the list sits in a
// height-capped scrolling column, where a scroll container would otherwise shrink to its border.
const DASHBOARD_TAB =
  'flex max-w-[16rem] items-center gap-1.5 group-data-[variant=line]/tabs-list:py-2 group-data-[variant=line]/tabs-list:font-ui group-data-[variant=line]/tabs-list:text-[0.85rem] group-data-[variant=line]/tabs-list:normal-case group-data-[variant=line]/tabs-list:tracking-normal';

function DashboardTabs({
  dashboards,
  currentId,
  onSelect,
}: {
  dashboards: Dashboard[];
  currentId: string;
  onSelect: (id: string) => void;
}) {
  return (
    <Tabs value={currentId} onValueChange={(v) => onSelect(String(v))} className="shrink-0">
      <TabsList
        variant="line"
        aria-label="Dashboards"
        className="flex-none gap-1 overflow-x-auto border-si-line"
      >
        {dashboards.map((d) => (
          <TabsTrigger key={d.id} value={d.id} className={DASHBOARD_TAB}>
            <span className="truncate">{d.title}</span>
            {d.via === 'mcp' && (
              <Badge variant="outline" size="sm">
                agent
              </Badge>
            )}
          </TabsTrigger>
        ))}
      </TabsList>
    </Tabs>
  );
}

function DashboardHeader({ dashboard: d }: { dashboard: Dashboard }) {
  const by = d.updatedBy?.name ?? d.createdBy?.name;
  return (
    <header className="flex min-w-0 flex-col gap-1">
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <h3 className="m-0 min-w-0 truncate text-[1rem] font-semibold text-si-fg">{d.title}</h3>
        {d.via === 'mcp' && <Badge variant="outline">agent</Badge>}
        <span className="text-[0.75rem] tabular-nums text-si-dim">rev {d.revision}</span>
      </div>
      <p className="m-0 text-[0.78rem] text-si-muted">
        Updated {fmtDate(d.updatedAt)}
        {by ? ` by ${by}` : ''}
      </p>
      {d.spec.description && (
        <p className="m-0 text-[0.85rem] text-si-fg/90">{d.spec.description}</p>
      )}
    </header>
  );
}
