// One labelled, copyable value (ConnectCard's MCP URL and Claude Code lines). Presentational:
// the copy action is a callback, so the landing page's Agents mock renders the same markup.

import { Copy } from 'lucide-react';
import { Button } from '@/shared/components/ui/button';

export function CopyRow({
  label,
  value,
  onCopy,
}: {
  label: string;
  value: string;
  onCopy: (value: string) => void;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <span className="font-label text-[0.6875rem] font-semibold uppercase tracking-[0.12em] text-si-dim">
        {label}
      </span>
      <div className="flex min-w-0 items-center gap-2">
        <code
          className="min-w-0 flex-1 truncate rounded-ctl border border-si-line bg-si-bg px-2.5 py-1.5 font-tc text-[0.78rem] text-si-fg"
          title={value}
        >
          {value}
        </code>
        <Button
          variant="outline"
          size="sm"
          aria-label={`Copy ${label}`}
          onClick={() => onCopy(value)}
        >
          <Copy aria-hidden="true" />
          Copy
        </Button>
      </div>
    </div>
  );
}
