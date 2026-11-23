import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { Router } from 'wouter';
import { DocsMarkdown } from './DocsMarkdown';
import { extractHeadings } from './docsIndex';

const html = (body: string) =>
  renderToStaticMarkup(
    <Router ssrPath="/docs" ssrSearch="">
      <DocsMarkdown body={body} />
    </Router>,
  );

describe('DocsMarkdown', () => {
  it('gives headings the ids "On this page" links to', () => {
    const body = '## Setup\n\ntext\n\n## Setup\n\n### The `ops` registry (core)\n';
    const out = html(body);
    for (const h of extractHeadings(body)) expect(out).toContain(`id="${h.id}"`);
  });

  it('keeps app paths in place, opens other sites in a new tab and drops unsafe links', () => {
    const out = html(
      '[Topics](/docs/guide/topics) [Up](#setup) [Site](https://example.com) [Bad](javascript:alert(1)) [[Wiki]] <b>raw</b>',
    );
    expect(out).toContain('href="/docs/guide/topics"');
    expect(out).toContain('href="#setup"');
    expect(out).toMatch(/href="https:\/\/example\.com"[^>]*target="_blank"/);
    expect(out).not.toContain('javascript:');
    expect(out).toContain('[[Wiki]]');
    expect(out).not.toContain('<b>');
  });

  it('adds a copy button to code blocks', () => {
    expect(html('```sh\nnpm test\n```')).toContain('aria-label="Copy code"');
  });
});
