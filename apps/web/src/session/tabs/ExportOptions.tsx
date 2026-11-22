// The Export tab's download list, presentational (props in, markup out) so the landing page mock
// renders it too: `hrefFor` gives each format's download link; without it the buttons are plain
// spans (the mock, which downloads nothing).

import type { ExportFormat } from '@/api/rpc';
import { Button } from '@/shared/components/ui/button';
import { IconDownload } from '../feed';

const FORMATS: { format: ExportFormat; label: string; primary?: boolean; hint: string }[] = [
  {
    format: 'events.csv',
    label: 'Event feed CSV',
    primary: true,
    hint: 'Every logged event with timecode, category, value and message.',
  },
  {
    format: 'transcript.txt',
    label: 'Transcript (text)',
    primary: true,
    hint: 'Speaker-labelled plain text.',
  },
  {
    format: 'transcript.srt',
    label: 'Transcript subtitles (SRT)',
    primary: true,
    hint: 'Timed captions for video editors.',
  },
  {
    format: 'topics.csv',
    label: 'Topics CSV',
    primary: true,
    hint: 'Start, duration, level, title and summary.',
  },
  {
    format: 'events.jsonl',
    label: 'Event feed JSONL',
    hint: 'One JSON object per event, for scripts.',
  },
];

export function ExportOptions({ hrefFor }: { hrefFor?: (format: ExportFormat) => string }) {
  return (
    <div className="flex max-w-md flex-col gap-2">
      {FORMATS.map((f) => (
        <div key={f.format} className="flex flex-col gap-0.5">
          <Button
            variant={f.primary ? 'default' : 'outline'}
            className="justify-start"
            nativeButton={false}
            // biome-ignore lint/a11y/useAnchorContent: Button renders its label into the link
            render={hrefFor ? <a href={hrefFor(f.format)} download /> : <span />}
          >
            <IconDownload />
            {f.label}
          </Button>
          <span className="pl-1 text-xs text-si-dim">{f.hint}</span>
        </div>
      ))}
    </div>
  );
}
