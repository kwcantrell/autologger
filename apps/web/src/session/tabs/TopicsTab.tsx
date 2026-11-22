import type { Session } from '@autologger/contract';
import { BotIcon, FilmIcon } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useTopics } from '@/api/queries';
import { errorMessage, rpc } from '@/api/rpc';
import { settingsOpen } from '@/lib/store';
import { showToast } from '@/shared/components/Toast';
import { Button } from '@/shared/components/ui/button';
import { cn } from '@/shared/lib/utils';
import { useConfirm } from '@/shared/ui/ConfirmDialog';
import { Tooltip } from '@/shared/ui/Tooltip';
import { MakeVideoDialog, useMakeVideoBlocked } from '../../routes/compilations/MakeVideoDialog';
import { useWorkspace } from '../context';
import {
  FEED_EMPTY,
  FeedShell,
  FeedTable,
  feedCountLabel,
  IconPlus,
  ToolbarCaption,
} from '../feed';
import { TOPIC_COLUMNS, TopicRow } from './TopicRow';

export function TopicsTab({ session }: { session: Session }) {
  const { canWrite, seek } = useWorkspace();
  const q = useTopics(session.id);
  const { confirm, confirmElement } = useConfirm();
  const topics = q.data ?? [];
  const [makeVideo, setMakeVideo] = useState(false);
  const blocked =
    useMakeVideoBlocked(canWrite, session.showName) ??
    (session.sourceKind !== 'youtube' || !session.sourceUrl
      ? 'This session was not imported from YouTube, so there is no video to cut.'
      : null);
  const candidates = useMemo(
    () =>
      (q.data ?? []).map((t) => ({
        sessionId: t.sessionId,
        startSec: t.startSec,
        ...(t.durationSec > 0 ? { endSec: t.startSec + t.durationSec } : {}),
        label: t.title,
      })),
    [q.data],
  );

  const insert = async () => {
    try {
      const at = topics.length
        ? topics[topics.length - 1]!.startSec + Math.max(1, topics[topics.length - 1]!.durationSec)
        : 0;
      await rpc('topics.create', { sessionId: session.id, startSec: at, title: 'New topic' });
    } catch (e) {
      showToast(errorMessage(e), true);
    }
  };

  if (!q.isPending && !q.isError && topics.length === 0) {
    return (
      <FeedShell
        countLabel="0 topics"
        toolbar={
          canWrite && (
            <Button variant="glass" onClick={() => void insert()}>
              <ToolbarCaption label="Insert" icon={<IconPlus />} />
            </Button>
          )
        }
      >
        <div className={cn(FEED_EMPTY, 'flex flex-col items-center gap-3')}>
          <BotIcon className="size-6 text-si-dim" aria-hidden="true" />
          <p className="m-0 max-w-[34rem]">
            No topics yet. AutoLogger doesn't generate topics itself: an agent connected over MCP
            (Claude Code, claude.ai or Claude Desktop) reads the transcript and events and writes
            the topics here, as you. You can also insert them by hand.
          </p>
          <Button variant="outline" size="sm" onClick={() => settingsOpen.set('agents')}>
            Settings → Agents
          </Button>
        </div>
      </FeedShell>
    );
  }

  return (
    <FeedShell
      countLabel={feedCountLabel(topics.length, 'topic')}
      toolbar={
        <>
          <Tooltip content={blocked} disabled={!blocked}>
            <span className="inline-flex">
              <Button
                variant="glass"
                disabled={!!blocked || q.isPending || q.isError}
                onClick={() => setMakeVideo(true)}
              >
                <ToolbarCaption
                  label="Make video"
                  icon={<FilmIcon className="block size-[18px]" aria-hidden="true" />}
                />
              </Button>
            </span>
          </Tooltip>
          {canWrite && (
            <Button variant="glass" onClick={() => void insert()}>
              <ToolbarCaption label="Insert" icon={<IconPlus />} />
            </Button>
          )}
        </>
      }
    >
      {q.isError ? (
        <p className="m-0 text-sm text-si-danger">
          Couldn't load the topics. {errorMessage(q.error)}
        </p>
      ) : (
        <FeedTable columns={TOPIC_COLUMNS} loading={q.isPending}>
          {topics.map((t) => (
            <TopicRow
              key={t.id}
              t={t}
              canWrite={canWrite}
              rolling={session.isRolling}
              onJump={(sec) => seek(sec, true)}
              onSave={(patch) =>
                rpc('topics.update', { topicId: t.id, ...patch }).catch((e) => {
                  showToast(`Saving the topic failed. ${errorMessage(e)}`, true);
                  throw e;
                })
              }
              onDelete={async () => {
                if (
                  await confirm({
                    title: 'Delete topic',
                    message: `Delete “${t.title}”? It can be restored from the Agents tab change log.`,
                    confirmLabel: 'Delete',
                    danger: true,
                  })
                ) {
                  rpc('topics.delete', { topicId: t.id }).catch((e) =>
                    showToast(errorMessage(e), true),
                  );
                }
              }}
            />
          ))}
        </FeedTable>
      )}
      {confirmElement}
      <MakeVideoDialog
        showId={session.showId}
        open={makeVideo}
        onOpenChange={setMakeVideo}
        defaultTitle={`${session.title.trim() || 'Untitled session'} — topics`}
        candidates={candidates}
        sourceNoun="session’s topics"
        startTicked={false}
      />
    </FeedShell>
  );
}
