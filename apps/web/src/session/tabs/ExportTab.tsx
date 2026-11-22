import type { Session } from '@autologger/contract';
import { exportUrl, type ExportFormat } from '@/api/rpc';
import { Button } from '@/shared/components/ui/button';
import { FeedShell, IconDownload } from '../feed';

const FORMATS: { format: ExportFormat; label: string; primary?: boolean; hint: string }[] = [
  { format: 'events.csv', label: 'Event feed CSV', primary: true, hint: 'Every logged event with timecode, category, value and message.' },
  { format: 'transcript.txt', label: 'Transcript (text)', primary: true, hint: 'Speaker-labelled plain text.' },
  { format: 'transcript.srt', label: 'Transcript subtitles (SRT)', primary: true, hint: 'Timed captions for video editors.' },
  { format: 'topics.csv', label: 'Topics CSV', primary: true, hint: 'Start, duration, level, title and summary.' },
  { format: 'events.jsonl', label: 'Event feed JSONL', hint: 'One JSON object per event, for scripts.' },
];

export function ExportTab({ session }: { session: Session }) {
  return (
    <FeedShell countLabel="Export">
      <p className="m-0 mb-4 text-[0.85rem] text-si-muted">Download each feed of “{session.title || 'Untitled session'}” as a file.</p>
      <div className="flex max-w-md flex-col gap-2">
        {FORMATS.map((f) => (
          <div key={f.format} className="flex flex-col gap-0.5">
            <Button
              variant={f.primary ? 'default' : 'outline'}
              className="justify-start"
              nativeButton={false}
              render={<a href={exportUrl(session.id, f.format)} download />}
            >
              <IconDownload />
              {f.label}
            </Button>
            <span className="pl-1 text-xs text-si-dim">{f.hint}</span>
          </div>
        ))}
      </div>
    </FeedShell>
  );
}
