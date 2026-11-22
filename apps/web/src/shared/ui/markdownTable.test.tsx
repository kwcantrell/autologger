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

describe('wiki citations', () => {
  it('renders session range links as chips with the session title and range', () => {
    const body =
      'Dana on the dog [she said](/sessions/ses_1?t=61.5&to=3725) and [here](/sessions/ses_9?t=5).';
    const html = renderToStaticMarkup(
      <Router ssrPath="/wiki">
        <WikiMarkdown
          body={body}
          resolve={resolve}
          sessionTitle={(id) => (id === 'ses_1' ? 'Episode 12' : null)}
        />
      </Router>,
    );
    expect(html.match(/data-slot="wiki-citation"/g)).toHaveLength(2);
    expect(html).toContain('href="/sessions/ses_1?t=61.5&amp;to=3725"');
    expect(html).toContain('Episode 12');
    expect(html).toContain('00:01:01–01:02:05');
    expect(html).toContain('Unknown session');
    expect(html).toContain('00:00:05');
  });
});
