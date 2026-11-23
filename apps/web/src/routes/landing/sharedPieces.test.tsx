// The dashboard, wiki, compilation, import and export pieces shared by the app and the landing
// page mocks render from props alone (no query client, workspace context or socket), and the
// mocks stay decorative.

import type { Compilation, PlaylistImport, Widget } from '@autologger/contract';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { Router } from 'wouter';
import { CompilationCard } from '@/routes/compilations/CompilationCard';
import { PlaylistResult } from '@/routes/PlaylistResult';
import { BacklinksSection, WikiPageHeader } from '@/routes/wiki/WikiPageParts';
import {
  StatWidget,
  TableWidget,
  TimelineWidget,
  WidgetFrame,
} from '@/session/dashboards/WidgetParts';
import { ExportOptions } from '@/session/tabs/ExportOptions';
import { DashboardMock, ExportMock, ImportMock } from './mocks';
import { CompileMock, WikiMock } from './wikiMocks';

// wouter's Link reads the location; give it one outside a browser.
const html = (n: ReactNode) =>
  renderToStaticMarkup(
    <Router ssrPath="/" ssrSearch="">
      {n}
    </Router>,
  );
const noop = () => {};
const AT = '2026-03-14T20:00:00.000Z';

describe('shared app pieces', () => {
  it('dashboard widgets render a spec and its rows', () => {
    const stat: Extract<Widget, { type: 'stat' }> = {
      id: 's',
      type: 'stat',
      title: 'Talk time',
      span: 1,
      value: 3492,
      format: 'duration',
    };
    const out = html(
      <WidgetFrame widget={stat}>
        <StatWidget widget={stat} rows={[]} />
      </WidgetFrame>,
    );
    expect(out).toContain('md:col-span-1');
    expect(out).toContain('>Talk time</h3>');
    expect(out).toContain('>58:12</span>');

    const timeline: Extract<Widget, { type: 'timeline' }> = {
      id: 't',
      type: 'timeline',
      title: '',
      span: 4,
      at: 'startSec',
      label: 'title',
      duration: 'durationSec',
    };
    const tl = html(
      <TimelineWidget
        widget={timeline}
        rows={[{ startSec: 252, durationSec: 678, title: 'Listener mail' }]}
        onSeek={noop}
      />,
    );
    expect(tl).toContain('aria-label="Jump to 4:12 Listener mail"');

    // A table without columns shows atSec as a duration, not raw seconds.
    const table: Extract<Widget, { type: 'table' }> = {
      id: 'e',
      type: 'table',
      title: '',
      span: 4,
    };
    const tb = html(<TableWidget widget={table} rows={[{ atSec: 48.958, label: 'Laugh' }]} />);
    expect(tb).toContain('>0:48</td>');
    expect(tb).not.toContain('48.96');
  });

  it('ExportOptions links each format only when given hrefs', () => {
    const linked = html(<ExportOptions hrefFor={(f) => `/x/${f}`} />);
    expect(linked).toContain('href="/x/transcript.srt" download=""');
    const plain = html(<ExportOptions />);
    expect(plain).not.toContain('<a ');
    expect(plain).toContain('Event feed JSONL');
  });

  it('PlaylistResult previews the sessions to create and the skipped videos', () => {
    const data: PlaylistImport = {
      playlistTitle: 'Season 3',
      dryRun: true,
      created: [
        {
          sessionId: null,
          title: 'Ep. 112',
          episode: '112',
          videoId: 'v',
          durationSec: 61,
          jobId: null,
        },
      ],
      skipped: [{ videoId: 'w', title: 'Ep. 111', reason: 'already_imported', sessionId: null }],
    };
    const out = html(<PlaylistResult data={data} onOpenSession={noop} />);
    expect(out).toContain(' · 1 new session will be created.');
    expect(out).toContain('#112');
    expect(out).toContain('Already in the show');
  });

  it('CompilationCard shows a build in progress', () => {
    const c: Compilation = {
      id: 'c',
      showId: 's',
      title: 'Saga',
      buildLocally: false,
      status: 'running',
      progress: 'Cutting clip 2 of 3',
      etaSec: 60,
      clips: [{ sessionId: 'x', sessionTitle: 'Ep. 112', startSec: 750, endSec: 910 }],
      durationSec: 160,
      createdBy: null,
      createdAt: AT,
      updatedAt: AT,
    };
    const out = html(
      <CompilationCard
        c={c}
        canWrite={false}
        onDelete={noop}
        deleting={false}
        onRetry={noop}
        retrying={false}
      />,
    );
    expect(out).toContain('Building');
    expect(out).toContain('Cutting clip 2 of 3 · about 1 min left');
    expect(out).not.toContain('<video');
  });

  it('wiki header and backlinks render from a page', () => {
    const head = html(
      <WikiPageHeader
        page={{
          kind: 'session',
          title: 'Ep. 112 recap',
          aliases: [],
          updatedBy: null,
          updatedAt: AT,
          revision: 3,
          sessionId: 'ses1',
        }}
      />,
    );
    expect(head).toContain('>Session</span>');
    expect(head).toContain('someone');
    expect(head).toContain('href="/sessions/ses1"');
    const back = html(
      <BacklinksSection backlinks={[{ id: 'w1', title: 'Dana', kind: 'person' }]} />,
    );
    expect(back).toContain('href="/wiki/w1"');
    expect(back).toContain('>Person</span>');
  });

  it('landing mocks render the shared pieces, hidden and inert', () => {
    for (const Mock of [DashboardMock, WikiMock, CompileMock, ImportMock, ExportMock]) {
      expect(html(<Mock />)).toMatch(/^<div aria-hidden="true" inert=""/);
    }
    expect(html(<WikiMock />)).toContain('data-slot="wiki-citation"');
    expect(html(<ExportMock />)).not.toContain('<a ');
  });
});
