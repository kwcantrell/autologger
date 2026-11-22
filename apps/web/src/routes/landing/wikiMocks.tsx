// The landing page's wiki and Ask & compile mocks. They render the real WikiMarkdown, so they
// are kept apart from mocks.tsx: LandingPage loads this file (and react-markdown with it) only
// when one of these rows nears the viewport.

import type { Compilation } from '@autologger/contract';
import { CompilationCard } from '@/routes/compilations/CompilationCard';
import { WikiMarkdown } from '@/routes/wiki/WikiMarkdown';
import { BacklinksSection, WikiPageHeader } from '@/routes/wiki/WikiPageParts';
import type { WikiResolver } from '@/routes/wiki/wikiShared';
import { HOST, MOCK_AT, MockFrame, noop, TC } from './heroMock';

// Sample wiki: the pages [[links]] resolve to and the sessions citations name.
const WIKI_PAGES = ['Lightning Round', 'Parking Ticket Saga', 'Priya Nair', 'Ep. 112 recap'];
const resolveWiki: WikiResolver = (title) =>
  WIKI_PAGES.includes(title) ? { id: `wiki-${WIKI_PAGES.indexOf(title)}`, title } : null;
const SESSION_TITLES: Record<string, string> = {
  ses109: 'Ep. 109 · Sandwich court',
  ses112: 'Ep. 112 · The long table',
  ses118: 'Ep. 118 · Live in Tulsa',
};
const sessionTitle = (id: string) => SESSION_TITLES[id] ?? null;

/** Wiki: a person page (the real header, body with [[links]] and a citation, and backlinks). */
export function WikiMock() {
  return (
    <MockFrame title="Show wiki">
      <div className="flex flex-col gap-4">
        <WikiPageHeader
          page={{
            kind: 'person',
            title: 'Dana Ruiz',
            aliases: ['Dana'],
            updatedBy: HOST,
            updatedAt: MOCK_AT,
            revision: 14,
            sessionId: null,
          }}
        />
        <WikiMarkdown
          body={[
            'Co-host since Ep. 1. Runs the [[Lightning Round]] and keeps the running tally for the [[Parking Ticket Saga]].',
            'Toured with [[Priya Nair]] in 2024; first told the double-ticket story in [[Ep. 112 recap]] [@ses112:2512-2541].',
          ].join('\n\n')}
          resolve={resolveWiki}
          sessionTitle={sessionTitle}
        />
        <BacklinksSection
          backlinks={[
            { id: 'wiki-3', title: 'Ep. 112 recap', kind: 'session' },
            { id: 'wiki-0', title: 'Lightning Round', kind: 'bit' },
            { id: 'wiki-1', title: 'Parking Ticket Saga', kind: 'bit' },
          ]}
        />
      </div>
    </MockFrame>
  );
}

/**
 * Ask & compile: a question page whose citations become one video (the real wiki body and
 * compilation card, building).
 */
export function CompileMock() {
  const compilation: Compilation = {
    id: 'comp-mock',
    showId: 'mock',
    title: 'The Parking Ticket Saga',
    status: 'running',
    progress: 'Cutting clip 2 of 3',
    etaSec: 60,
    clips: [
      { sessionId: 'ses109', sessionTitle: SESSION_TITLES.ses109!, startSec: 2462, endSec: 2590 },
      { sessionId: 'ses112', sessionTitle: SESSION_TITLES.ses112!, startSec: 750, endSec: 910 },
      { sessionId: 'ses118', sessionTitle: SESSION_TITLES.ses118!, startSec: 3855, endSec: 3940 },
    ],
    durationSec: 373,
    createdBy: HOST,
    createdAt: MOCK_AT,
    updatedAt: MOCK_AT,
  };
  return (
    <MockFrame title="Question" aside={<span className={TC}>3 citations</span>}>
      <div className="flex flex-col gap-4">
        <WikiMarkdown
          body={[
            '## How did the Parking Ticket Saga start?',
            'Dana got two tickets for the same spot on the same morning [@ses109:2462-2590], told it on air [@ses112:750-910] and kept a running tally until Tulsa [@ses118:3855-3940].',
          ].join('\n\n')}
          resolve={resolveWiki}
          sessionTitle={sessionTitle}
        />
        <ul className="m-0 list-none p-0">
          <CompilationCard
            c={compilation}
            canWrite
            onDelete={noop}
            deleting={false}
            onRetry={noop}
            retrying={false}
          />
        </ul>
      </div>
    </MockFrame>
  );
}
