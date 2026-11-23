import { memo } from 'react';
import { exportUrl } from '@/api/rpc';
import { useSessionSlice } from '../context';
import { FeedShell } from '../feed';
import { ExportOptions } from './ExportOptions';

export const ExportTab = memo(function ExportTab() {
  const session = useSessionSlice((s) => ({ id: s.id, title: s.title }));

  return (
    <FeedShell countLabel="Export">
      <p className="m-0 mb-4 text-[0.85rem] text-si-muted">
        Download each feed of “{session.title || 'Untitled session'}” as a file.
      </p>
      <ExportOptions hrefFor={(format) => exportUrl(session.id, format)} />
    </FeedShell>
  );
});
