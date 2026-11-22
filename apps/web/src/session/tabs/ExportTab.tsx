import type { Session } from '@autologger/contract';
import { exportUrl } from '@/api/rpc';
import { FeedShell } from '../feed';
import { ExportOptions } from './ExportOptions';

export function ExportTab({ session }: { session: Session }) {
  return (
    <FeedShell countLabel="Export">
      <p className="m-0 mb-4 text-[0.85rem] text-si-muted">
        Download each feed of “{session.title || 'Untitled session'}” as a file.
      </p>
      <ExportOptions hrefFor={(format) => exportUrl(session.id, format)} />
    </FeedShell>
  );
}
