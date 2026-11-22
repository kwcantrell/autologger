// GFM table renderers shared by the agent-authored Markdown views (wiki pages, dashboard markdown
// widgets). Built on the table primitives so a Markdown table reads like the app's feed tables.
// The wrapper is the horizontal scroll container: a wide table scrolls inside its own box at
// phone width instead of widening the page. Headers are not sticky here (the primitive's sticky
// head would stick to this wrapper, which never scrolls vertically). Column alignment from the
// `:---:` row arrives as an inline text-align style and is passed through.

import type { Components } from 'react-markdown';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '../components/ui/table';

export const markdownTableComponents: Components = {
  table: ({ node: _node, ...props }) => (
    <div data-slot="markdown-table" className="my-3 max-w-full overflow-x-auto">
      <Table className="w-auto min-w-full [overflow-wrap:normal]" {...props} />
    </div>
  ),
  thead: ({ node: _node, ...props }) => <TableHeader {...props} />,
  tbody: ({ node: _node, ...props }) => <TableBody {...props} />,
  tr: ({ node: _node, ...props }) => (
    <TableRow className="[border-bottom:1px_solid_var(--si-line)] last:border-b-0" {...props} />
  ),
  th: ({ node: _node, ...props }) => <TableHead className="static z-auto text-left" {...props} />,
  td: ({ node: _node, ...props }) => (
    <TableCell className="px-[0.625rem] py-[0.4375rem] align-top" {...props} />
  ),
};
