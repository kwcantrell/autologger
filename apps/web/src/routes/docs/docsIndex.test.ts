import { describe, expect, it } from 'vitest';
import { landingLinks } from '../landing/links';
import {
  type DocMeta,
  docMetaFromFile,
  docNeighbours,
  docSections,
  extractHeadings,
  parseFrontMatter,
  sortDocs,
} from './docsIndex';

const page = (fm: string, body = 'Body.') => `---\n${fm}\n---\n\n${body}\n`;

describe('parseFrontMatter', () => {
  it('splits key: value pairs off the body, dropping quotes and comments', () => {
    const fm = parseFrontMatter(
      page(
        'title: "Logging: a session"\n# a comment\n\norder: 20\ndescription: It\'s live.',
        '# Hi',
      ),
    );
    expect(fm).toEqual({
      data: { title: 'Logging: a session', order: '20', description: "It's live." },
      body: '# Hi\n',
    });
  });

  it('returns null for a file without front matter (not published)', () => {
    expect(parseFrontMatter('# UI inventory\n\n---\n')).toBeNull();
  });

  it('throws on an unclosed block or a line that is not key: value', () => {
    expect(() => parseFrontMatter('---\ntitle: x\n')).toThrow(/not closed/);
    expect(() => parseFrontMatter('---\njust text\n---\n')).toThrow(/key: value/);
  });
});

describe('docMetaFromFile', () => {
  const fm = 'title: Topics\nsection: guide\norder: 35\ndescription: Chapters.';

  it('maps docs/<section>/<slug>.md to its path', () => {
    expect(docMetaFromFile('guide/topics.md', page(fm))).toEqual({
      path: 'guide/topics',
      file: 'docs/guide/topics.md',
      title: 'Topics',
      description: 'Chapters.',
      section: 'guide',
      order: 35,
    });
    expect(docMetaFromFile('index.md', page('title: Docs\ndescription: Home.'))?.path).toBe('');
    expect(docMetaFromFile('ui-inventory.md', '# Inventory\n')).toBeNull();
  });

  it('refuses pages that would publish wrongly', () => {
    expect(() => docMetaFromFile('guide/topics.md', page('title: T\nsection: guide'))).toThrow(
      /description/,
    );
    expect(() => docMetaFromFile('agents/topics.md', page(fm))).toThrow(/section must be "agents"/);
    expect(() => docMetaFromFile('misc/topics.md', page(fm))).toThrow(/unknown section/);
    expect(() => docMetaFromFile('guide/Topics.md', page(fm))).toThrow(/lowercase/);
    expect(() => docMetaFromFile('topics.md', page(fm))).toThrow(/docs\/<section>/);
    expect(() =>
      docMetaFromFile('guide/topics.md', page(fm.replace('order: 35', 'order: soon'))),
    ).toThrow(/order/);
  });
});

describe('navigation order', () => {
  const meta = (path: string, title: string, order: number): DocMeta => ({
    path,
    file: `docs/${path || 'index'}.md`,
    title,
    description: '',
    section: (path.split('/')[0] || null) as DocMeta['section'],
    order,
  });
  const sorted = sortDocs([
    meta('developers/mcp-server', 'MCP server', 10),
    meta('guide/wiki', 'Wiki', 50),
    meta('agents/plugins', 'Plugins', 20),
    meta('guide/topics', 'Topics', 35),
    meta('guide/dashboards', 'Dashboards', 35),
    meta('', 'Docs', 0),
  ]);

  it('reads home, then guide, agents, developers by order then title', () => {
    expect(sorted.map((p) => p.path)).toEqual([
      '',
      'guide/dashboards',
      'guide/topics',
      'guide/wiki',
      'agents/plugins',
      'developers/mcp-server',
    ]);
  });

  it('groups sections that have pages and finds neighbours across them', () => {
    expect(docSections(sorted).map((s) => [s.label, s.pages.length])).toEqual([
      ['Using AutoLogger', 3],
      ['Agents & MCP', 1],
      ['Developers', 1],
    ]);
    const { prev, next } = docNeighbours(sorted, 'guide/wiki');
    expect([prev?.path, next?.path]).toEqual(['guide/topics', 'agents/plugins']);
    expect(docNeighbours(sorted, '').prev).toBeNull();
    expect(docNeighbours(sorted, 'developers/mcp-server').next).toBeNull();
    expect(docNeighbours(sorted, 'guide/nope')).toEqual({ prev: null, next: null });
  });
});

describe('extractHeadings', () => {
  it('slugs headings like the renderer, skipping fenced code and de-duplicating', () => {
    const body = [
      '## The `ops` registry (the core idea)',
      '```sh',
      '# not a heading',
      '```',
      '### See [Topics](/docs/guide/topics) & **more**',
      '## Setup',
      '## Setup',
      '## snake_case_name ##',
      '## autologger-ask',
      '### Import from your own computer',
    ].join('\n');
    expect(extractHeadings(body)).toEqual([
      { depth: 2, text: 'The ops registry (the core idea)', id: 'the-ops-registry-the-core-idea' },
      { depth: 3, text: 'See Topics & more', id: 'see-topics-more' },
      { depth: 2, text: 'Setup', id: 'setup' },
      { depth: 2, text: 'Setup', id: 'setup-1' },
      { depth: 2, text: 'snake_case_name', id: 'snakecasename' },
      { depth: 2, text: 'autologger-ask', id: 'autologger-ask' },
      { depth: 3, text: 'Import from your own computer', id: 'import-from-your-own-computer' },
    ]);
  });
});

describe('landing links', () => {
  it('point at the built-in docs, or at DOCS_URL when the server sets it', () => {
    const local = landingLinks();
    expect(local.docsHomeHref).toBe('/docs');
    expect(local.mcpServer.href).toBe('/docs/developers/mcp-server');
    const ext = landingLinks('https://docs.example.com/al');
    expect(ext.docsHomeHref).toBe('https://docs.example.com/al');
    expect(ext.connectAgentHref).toBe('https://docs.example.com/al/agents/connecting-agents');
    // GitHub stays GitHub.
    expect(ext.marketplace.href).toMatch(/^https:\/\/github\.com\//);
    expect(ext.github.href).toMatch(/^https:\/\/github\.com\//);
  });
});
