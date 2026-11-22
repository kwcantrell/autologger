// GFM tables in both agent-authored Markdown views: rendered as tables inside a scroll wrapper,
// with the safety rules (no raw HTML, URL allow-list) and [[wiki links]] intact in cells.

import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { Router } from 'wouter';
import { WikiMarkdown } from '@/routes/wiki/WikiMarkdown';
import { SpecMarkdown } from '@/session/dashboards/Markdown';

const TABLE = [
  '| # | Recap | Link |',
  '|---|:---:|---|',
  '| 1 | [[Pilot]] ~~old~~ | [site](https://example.com) |',
  '| 2 | [[Pilot\\|first one]] <b>raw</b> | [bad](javascript:alert(1)) |',
].join('\n');

const resolve = (title: string) =>
  title.toLowerCase() === 'pilot' ? { id: 'p1', title: 'Pilot' } : null;

describe('Markdown GFM tables', () => {
  it('renders a wiki table with wiki links in cells and the safety rules kept', () => {
    const html = renderToStaticMarkup(
      <Router ssrPath="/wiki">
        <WikiMarkdown body={TABLE} resolve={resolve} />
      </Router>,
    );
    expect(html).toContain('data-slot="markdown-table"');
    expect(html).toContain('overflow-x-auto');
    expect(html.match(/<tr/g)).toHaveLength(3);
    expect(html).toContain('text-align:center');
    expect(html).toMatch(/<a [^>]*href="\/wiki\/p1"[^>]*>Pilot<\/a>/);
    expect(html).toMatch(/<a [^>]*href="\/wiki\/p1"[^>]*>first one<\/a>/);
    expect(html).toContain('<del>old</del>');
    expect(html).toContain('href="https://example.com"');
    expect(html).not.toContain('javascript:');
    expect(html).not.toContain('<b>');
  });

  it('renders a dashboard markdown table', () => {
    const html = renderToStaticMarkup(<SpecMarkdown source={TABLE} />);
    expect(html).toContain('data-slot="markdown-table"');
    expect(html.match(/<th[ >]/g)).toHaveLength(3);
    expect(html).toContain('href="https://example.com"');
    expect(html).not.toContain('javascript:');
    expect(html).not.toContain('<b>');
  });

  it('renders task lists', () => {
    const html = renderToStaticMarkup(<SpecMarkdown source={'- [x] done\n- [ ] todo'} />);
    expect(html.match(/type="checkbox"/g)).toHaveLength(2);
    expect(html).toContain('list-none');
  });
});
