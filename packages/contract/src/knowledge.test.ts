import { describe, expect, it } from 'vitest';
import { plainText, wikiBlocks, wikiSections } from './knowledge.ts';

const page = `Opening paragraph about [[Joe DeRosa]] [00:01:00](@60-90).

## Rundown

### Pig Talk letters

- Joe reads a letter from [[Pig Talk|a pig]] [VAH_0006 00:20:00](/sessions/ses_b/?t=1200&to=1260)
  and laughs [@1300-1310].
- **Second** item without citations.

| Ep | Summary |
|----|---------|
| [[VAH_0002]] | Flight Log debuts [00:17:22](@ses_c:1042-1100) |

\`\`\`
[[Not a link]] [x](@1-2)
\`\`\`

## Best moments
A quote: *"never again"* [01:00:00](@3600-3610).`;

describe('wikiBlocks', () => {
  const blocks = wikiBlocks(page, 'ses_a');

  it('splits paragraphs, list items and table rows under their headings, skipping code', () => {
    expect(blocks.map((b) => [b.headings.join(' › '), b.text])).toEqual([
      ['', 'Opening paragraph about Joe DeRosa 00:01:00.'],
      ['Rundown › Pig Talk letters', 'Joe reads a letter from a pig VAH_0006 00:20:00 and laughs.'],
      ['Rundown › Pig Talk letters', 'Second item without citations.'],
      ['Rundown › Pig Talk letters', 'Ep · Summary'],
      ['Rundown › Pig Talk letters', 'VAH_0002 · Flight Log debuts 00:17:22'],
      ['Best moments', 'A quote: "never again" 01:00:00.'],
    ]);
  });

  it('keeps each block’s citations (short forms resolved to the page session) and links', () => {
    expect(blocks[1]!.citations).toEqual([
      { sessionId: 'ses_b', startSec: 1200, endSec: 1260, label: 'VAH_0006 00:20:00' },
      { sessionId: 'ses_a', startSec: 1300, endSec: 1310, label: '' },
    ]);
    expect(blocks[1]!.links).toEqual(['Pig Talk']);
    expect(blocks[4]!.citations[0]).toMatchObject({ sessionId: 'ses_c', startSec: 1042 });
    expect(blocks[4]!.links).toEqual(['VAH_0002']);
    expect(blocks.flatMap((b) => b.links)).not.toContain('Not a link');
  });
});

describe('claims', () => {
  it('gives each citation of a block its own sentence and links', () => {
    const [block] = wikiBlocks(
      'Submissions go to [[Inbox]] [a](@1-2). [[Carly]] reads one [b](@3-4); Joe answers [c](@5-6). [d](@7-8)',
      'ses_a',
    );
    expect(block!.claims.map((c) => [c.citation.startSec, c.text, c.links])).toEqual([
      [1, 'Submissions go to Inbox', ['Inbox']],
      [3, 'Carly reads one', ['Carly']],
      [5, 'Joe answers', []],
      // A citation opening its sentence takes the previous one.
      [7, 'Joe answers', []],
    ]);
    expect(plainText('x [a](@1-2) y', { citations: false })).toBe('x y');
  });
});

describe('wikiSections', () => {
  it('splits at every heading and keeps the heading path', () => {
    const sections = wikiSections(page, 'ses_a');
    expect(sections.map((s) => s.headings.join(' › '))).toEqual([
      '',
      'Rundown › Pig Talk letters',
      'Best moments',
    ]);
    expect(sections[1]!.citations).toHaveLength(3);
    expect(sections[1]!.markdown).toContain('[[Not a link]]');
    expect(sections[1]!.links).toEqual(['Pig Talk', 'VAH_0002']);
  });
});

describe('plainText', () => {
  it('drops markup but keeps words', () => {
    expect(plainText('**Bold** _it_ `code` [[A\\|b]] [label](https://x.y) > q')).toBe(
      'Bold it code b label > q',
    );
  });
});
