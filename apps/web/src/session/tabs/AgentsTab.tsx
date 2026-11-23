// Agents tab: how to connect an MCP agent, and the session's change log with undo.

import type { Change, Session } from '@autologger/contract';
import type { QueryKey } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import {
  qk,
  useCapabilities,
  useChanges,
  useEvents,
  useOpMutation,
  useTopics,
} from '@/api/queries';
import { errorMessage } from '@/api/rpc';
import { settingsOpen } from '@/lib/store';
import { eventSec } from '@/lib/timecode';
import { useWorkspace } from '@/session/context';
import { FeedShell, FeedTable, IconFilter, ToolbarCaption } from '@/session/feed';
import { showToast } from '@/shared/components/Toast';
import { Button } from '@/shared/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '@/shared/components/ui/dropdown-menu';
import { useConfirm } from '@/shared/ui/ConfirmDialog';
import { Tooltip } from '@/shared/ui/Tooltip';
import { CHANGE_COLUMNS, CHANGE_STACK, ChangeRow } from './ChangeRow';
import { CopyRow } from './CopyRow';

type Filter = 'all' | 'mcp' | 'operators';
const FILTER_LABEL: Record<Filter, string> = {
  all: 'All changes',
  mcp: 'Agents only',
  operators: 'Operators',
};
const EMPTY: Record<Filter, string> = {
  all: 'Nothing has changed in this session yet.',
  mcp: 'No agent has changed this session yet.',
  operators: 'No operator changes in this session yet.',
};
const LIMIT = 300;

// ── relative time ───────────────────────────────────────────────────

function useNow(ms = 30_000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}

// ── tab ─────────────────────────────────────────────────────────────

export function AgentsTab({ session }: { session: Session }) {
  return (
    <div className="flex min-w-0 flex-col gap-3">
      <ConnectCard />
      <ChangeFeed session={session} />
    </div>
  );
}

function copyToClipboard(value: string) {
  navigator.clipboard.writeText(value).then(
    () => showToast('Copied.'),
    () => showToast('Could not copy to the clipboard.', true),
  );
}

function ConnectCard() {
  const caps = useCapabilities();
  const base = caps.data?.publicUrl.replace(/\/+$/, '');
  const mcpUrl = base ? `${base}/mcp` : null;
  return (
    <section
      aria-labelledby="agents-connect-title"
      className="mx-4 flex min-w-0 flex-col gap-3 rounded-card border border-si-line bg-si-panel px-6 py-4 max-md:mx-3 max-md:px-3"
    >
      <div className="flex min-w-0 flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <h2
            id="agents-connect-title"
            className="m-0 font-ui text-[1.25rem] font-semibold leading-tight text-si-fg"
          >
            Connect an agent
          </h2>
          <p className="m-0 mt-1 max-w-[60ch] text-[0.85rem] leading-[1.45] text-si-muted">
            Agents like Claude Code, claude.ai or Claude Desktop connect over MCP and act as you.
            Every change they make appears below and can be undone.
          </p>
        </div>
        <Button variant="link" className="px-0" onClick={() => settingsOpen.set('agents')}>
          Settings → Agents
        </Button>
      </div>
      {mcpUrl ? (
        <div className="grid min-w-0 gap-3 md:grid-cols-2">
          <CopyRow label="MCP URL" value={mcpUrl} onCopy={copyToClipboard} />
          <CopyRow
            label="Claude Code"
            value={`claude mcp add --transport http autologger ${mcpUrl}`}
            onCopy={copyToClipboard}
          />
        </div>
      ) : caps.isError ? (
        <p role="alert" className="m-0 text-[0.85rem] text-(--si-danger)">
          Could not load the server address. {errorMessage(caps.error)}
        </p>
      ) : (
        <p className="m-0 text-[0.85rem] text-si-muted">Loading…</p>
      )}
    </section>
  );
}

function ChangeFeed({ session }: { session: Session }) {
  const { canWrite, seek } = useWorkspace();
  const [filter, setFilter] = useState<Filter>('all');
  const changes = useChanges(session.id, filter === 'mcp' ? 'mcp' : 'all');
  const events = useEvents(session.id);
  const topics = useTopics(session.id);
  const now = useNow();
  const { confirm, confirmElement } = useConfirm();
  const [rowErrors, setRowErrors] = useState<Record<string, string>>({});
  const revert = useOpMutation('changes.revert', {
    invalidate: (c) => {
      const keys: QueryKey[] = [qk.changesAll(session.id)];
      if (c.entity === 'dashboard') keys.push(qk.dashboards(session.id));
      if (c.entity === 'event') keys.push(qk.events(session.id));
      if (c.entity === 'topic') keys.push(qk.topics(session.id));
      if (c.entity === 'transcript_segment') keys.push(qk.transcript(session.id));
      if (c.entity === 'audio_segment') keys.push(qk.media(session.id), qk.session(session.id));
      return keys;
    },
  });
  // A folded row stands for one op call; its changes may touch several kinds of content.
  const revertGroup = useOpMutation('changes.revertGroup', {
    invalidate: () => [
      qk.changesAll(session.id),
      qk.dashboards(session.id),
      qk.events(session.id),
      qk.topics(session.id),
      qk.transcript(session.id),
      qk.media(session.id),
      qk.session(session.id),
    ],
  });

  const rows = useMemo(() => {
    const all = changes.data ?? [];
    return filter === 'operators'
      ? all.filter((c) => c.via === 'web' || c.via === 'companion')
      : all;
  }, [changes.data, filter]);

  const secOf = useMemo(() => {
    const m = new Map<string, number>();
    for (const e of events.data ?? []) {
      const s = eventSec(e.timecodeFrames, session);
      if (s != null) m.set(`event:${e.id}`, s);
    }
    for (const t of topics.data ?? []) m.set(`topic:${t.id}`, t.startSec);
    return m;
  }, [events.data, topics.data, session]);

  const undo = async (c: Change) => {
    const group = c.groupSize && c.groupId ? c.groupId : null;
    const left = (c.groupSize ?? 1) - (c.groupUndone ?? 0);
    // The call also changed other sessions: revertGroup undoes those too (groupTotal counts all).
    const elsewhere = (c.groupTotal ?? 0) - (c.groupSize ?? 0);
    const ok = await confirm({
      title: !group
        ? 'Undo this change?'
        : elsewhere > 0
          ? `Undo all ${c.groupTotal} changes of this call?`
          : `Undo all ${left} changes?`,
      message: group ? (
        <>
          Everything this {c.op} call by {c.actor?.name ?? 'the system'} changed will be reverted in
          one step ({left} change{left === 1 ? '' : 's'} here, e.g. “{c.summary}”
          {elsewhere > 0 && (
            <>, and {elsewhere} more in other sessions — you need edit access to all of them</>
          )}
          ). Changes already undone are skipped. If any of it changed again since, nothing is
          undone. The undo is recorded too and can itself be undone.
        </>
      ) : (
        <>
          “{c.summary}” by {c.actor?.name ?? 'the system'} will be reverted. The undo is recorded
          too and can itself be undone.
        </>
      ),
      confirmLabel: group ? 'Undo all' : 'Undo',
    });
    if (!ok) return;
    setRowErrors(({ [c.id]: _, ...rest }) => rest);
    const onError = (e: unknown) => {
      const msg = errorMessage(e);
      setRowErrors((m) => ({ ...m, [c.id]: msg }));
      showToast(`Undo failed: ${msg}`, true);
    };
    if (group)
      revertGroup.mutate(
        { groupId: group },
        {
          onSuccess: (r) => showToast(`${r.reverted} change${r.reverted === 1 ? '' : 's'} undone.`),
          onError,
        },
      );
    else
      revert.mutate({ changeId: c.id }, { onSuccess: () => showToast('Change undone.'), onError });
  };

  const capped = (changes.data?.length ?? 0) >= LIMIT;
  const n = `${rows.length}${capped ? '+' : ''}`;
  const countLabel = !changes.isSuccess
    ? 'Changes'
    : filter === 'mcp'
      ? `${n} agent action${rows.length === 1 ? '' : 's'}`
      : `${n} change${rows.length === 1 ? '' : 's'}`;

  const toolbar = (
    <DropdownMenu>
      <Tooltip content="Filter changes">
        <DropdownMenuTrigger render={<Button variant="glass" />}>
          <ToolbarCaption label={FILTER_LABEL[filter]} icon={<IconFilter />} />
        </DropdownMenuTrigger>
      </Tooltip>
      <DropdownMenuContent align="end" className="w-48">
        <DropdownMenuGroup>
          <DropdownMenuLabel>Show</DropdownMenuLabel>
          <DropdownMenuRadioGroup value={filter} onValueChange={(v: Filter) => setFilter(v)}>
            {(Object.keys(FILTER_LABEL) as Filter[]).map((f) => (
              <DropdownMenuRadioItem key={f} value={f}>
                {FILTER_LABEL[f]}
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );

  return (
    <FeedShell countLabel={countLabel} toolbar={toolbar}>
      {changes.isError ? (
        <p role="alert" className="m-0 py-4 text-[0.85rem] text-(--si-danger)">
          Could not load the change log. {errorMessage(changes.error)}
        </p>
      ) : (
        <FeedTable
          columns={CHANGE_COLUMNS}
          stack={CHANGE_STACK}
          loading={changes.isPending}
          empty={rows.length === 0}
          emptyMessage={EMPTY[filter]}
        >
          {rows.map((c) => (
            <ChangeRow
              key={c.id}
              change={c}
              now={now}
              sec={secOf.get(`${c.entity}:${c.entityId}`) ?? null}
              onJump={(s) => seek(s, true)}
              canWrite={canWrite}
              busy={
                (revert.isPending && revert.variables?.changeId === c.id) ||
                (revertGroup.isPending &&
                  !!c.groupSize &&
                  revertGroup.variables?.groupId === c.groupId)
              }
              error={rowErrors[c.id]}
              onUndo={() => void undo(c)}
            />
          ))}
        </FeedTable>
      )}
      {confirmElement}
    </FeedShell>
  );
}
