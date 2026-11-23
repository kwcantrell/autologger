import { eq } from 'drizzle-orm';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { newId } from '../core/ids.ts';
import { db, schema } from '../db/client.ts';
import { parseTranscript } from '../media/transcriptImport.ts';
import { asAgent, call, failsWith, makeUser, resetDb, setupDb, studio } from './harness.ts';

beforeAll(setupDb);
beforeEach(resetDb);

const SRT = `1
00:00:01,000 --> 00:00:04,500
Dana: Welcome back to the show.

2
00:00:04,500 --> 00:00:08,000
<i>Today we talk</i>
about &amp; around compilers.

3
00:00:08,000 --> 00:00:10,000
>> Sam Lee: Thanks for having me.
`;

const VTT = `WEBVTT
Kind: captions

NOTE made by an editor

intro
00:01.000 --> 00:03.000 align:start
<v Dana>Hello there.</v>

00:00:03.000 --> 00:00:06.250
<v.loud Sam Lee>Hi, Dana.
Good to be here.

00:00:06.250 --> 00:00:07.000
the answer is: yes
`;

describe('transcript.import parsing', () => {
  it('parses SRT cues, multi-line text, tags and speaker prefixes', () => {
    expect(parseTranscript('srt', SRT)).toEqual([
      { startSec: 1, endSec: 4.5, speaker: 'Dana', text: 'Welcome back to the show.' },
      {
        startSec: 4.5,
        endSec: 8,
        speaker: 'Dana',
        text: 'Today we talk about & around compilers.',
      },
      { startSec: 8, endSec: 10, speaker: 'Sam Lee', text: 'Thanks for having me.' },
    ]);
  });

  it('parses WebVTT voices, short timestamps, settings and skips NOTE blocks', () => {
    expect(parseTranscript('vtt', VTT)).toEqual([
      { startSec: 1, endSec: 3, speaker: 'Dana', text: 'Hello there.' },
      { startSec: 3, endSec: 6.25, speaker: 'Sam Lee', text: 'Hi, Dana. Good to be here.' },
      // Lower-case prose is not a speaker label; the previous speaker carries on.
      { startSec: 6.25, endSec: 7, speaker: 'Sam Lee', text: 'the answer is: yes' },
    ]);
  });

  it('names the line or item that failed', () => {
    expect(() => parseTranscript('srt', '1\n00:00:05,000 --> 00:00:01,000\nhi\n')).toThrow(
      /Line 2: cue ends/,
    );
    expect(() => parseTranscript('srt', '1\n00:00:xx --> 00:00:01,000\nhi\n')).toThrow(
      /Line 2: bad cue timing/,
    );
    expect(() => parseTranscript('vtt', '00:01.000 --> 00:02.000\nhi')).toThrow(/WEBVTT/);
    expect(() => parseTranscript('json', '[{"startSec":1,"endSec":0,"text":"x"}]')).toThrow(
      /Item 0: endSec/,
    );
    expect(() => parseTranscript('json', '{"a":1}')).toThrow(/array/);
  });
});

describe('transcript.import', () => {
  it('imports JSON at session level, replaces and appends, and undo restores the original', async () => {
    const { owner, session } = await studio();
    const agent = asAgent(owner, 'Claude Code');
    const json = JSON.stringify([
      { startSec: 0, endSec: 2, speaker: 'Dana', text: 'Hi.' },
      { startSec: 2, endSec: 5, speaker: 'Sam', text: 'Hello Dana, nice to meet you.' },
    ]);
    const first = await call(agent, 'transcript.import', {
      sessionId: session.id,
      format: 'json',
      content: json,
      mode: 'replace',
    });
    expect(first).toMatchObject({
      imported: 2,
      removed: 0,
      startSec: 0,
      endSec: 5,
      speakers: ['Dana', 'Sam'],
      transcriptStatus: 'done',
    });
    const segs = await call(owner, 'transcript.get', { sessionId: session.id });
    expect(segs[1]!.words.map((w) => w.w)).toEqual([
      'Hello',
      'Dana,',
      'nice',
      'to',
      'meet',
      'you.',
    ]);
    expect(segs[1]!.words[0]!.s).toBe(2);
    expect(segs[1]!.words.at(-1)!.e).toBe(5);
    expect((await call(owner, 'sessions.get', { sessionId: session.id })).transcriptStatus).toBe(
      'done',
    );
    const before = await call(owner, 'transcript.get', { sessionId: session.id });

    const appended = await call(agent, 'transcript.import', {
      sessionId: session.id,
      format: 'srt',
      content: SRT,
      mode: 'append',
    });
    expect(appended).toMatchObject({ imported: 3, removed: 0 });
    expect(await call(owner, 'transcript.get', { sessionId: session.id })).toHaveLength(5);

    const replaced = await call(agent, 'transcript.import', {
      sessionId: session.id,
      format: 'vtt',
      content: VTT,
      mode: 'replace',
    });
    expect(replaced).toMatchObject({ imported: 3, removed: 5 });
    const text = await call(owner, 'transcript.text', { sessionId: session.id });
    expect(text.text).toContain('Sam Lee: Hi, Dana. Good to be here.');

    // One group per call: undo the replace, then the append, and the first import is back.
    const undo = await call(owner, 'changes.revertGroup', { groupId: replaced.groupId });
    expect(undo.reverted).toBe(8);
    await call(owner, 'changes.revertGroup', { groupId: appended.groupId });
    expect(await call(owner, 'transcript.get', { sessionId: session.id })).toEqual(before);
  });

  it('attaches to an audio segment with its offset and marks it transcribed', async () => {
    const { owner, session } = await studio();
    const audioId = newId('aud');
    await db.insert(schema.audioSegments).values({
      id: audioId,
      sessionId: session.id,
      ordinal: 0,
      startSec: 100,
      mimeType: 'audio/mpeg',
      origin: 'youtube',
      objectKey: `test/${audioId}`,
      status: 'ready',
    });
    // An existing session-level line stays: replace with audioSegmentId only touches that audio.
    await call(owner, 'transcript.import', {
      sessionId: session.id,
      format: 'json',
      content: '[{"startSec":0,"endSec":1,"text":"Cold open."}]',
      mode: 'append',
    });
    const out = await call(owner, 'transcript.import', {
      sessionId: session.id,
      audioSegmentId: audioId,
      format: 'srt',
      content: SRT,
      mode: 'replace',
    });
    expect(out).toMatchObject({ imported: 3, removed: 0, startSec: 101, endSec: 110 });
    const segs = await call(owner, 'transcript.get', { sessionId: session.id });
    expect(segs.map((s) => [s.startSec, s.audioSegmentId])).toEqual([
      [0, null],
      [101, audioId],
      [104.5, audioId],
      [108, audioId],
    ]);
    const [audio] = await call(owner, 'media.list', { sessionId: session.id });
    expect(audio!.status).toBe('transcribed');
  });

  it('undo and redo of an import onto a recording restore its status (#294)', async () => {
    const { owner, session } = await studio();
    const audioId = newId('aud');
    await db.insert(schema.audioSegments).values({
      id: audioId,
      sessionId: session.id,
      ordinal: 0,
      mimeType: 'audio/mpeg',
      origin: 'youtube',
      objectKey: `test/${audioId}`,
      status: 'ready',
    });
    const state = async () => ({
      status: (await call(owner, 'media.list', { sessionId: session.id }))[0]!.status,
      transcriptStatus: (await call(owner, 'sessions.get', { sessionId: session.id }))
        .transcriptStatus,
      segments: (await call(owner, 'transcript.get', { sessionId: session.id })).length,
    });
    const original = await state();
    expect(original.status).toBe('ready');
    const out = await call(owner, 'transcript.import', {
      sessionId: session.id,
      audioSegmentId: audioId,
      format: 'srt',
      content: SRT,
      mode: 'replace',
    });
    const imported = await state();
    expect(imported).toEqual({ status: 'transcribed', transcriptStatus: 'done', segments: 3 });

    const undo = await call(owner, 'changes.revertGroup', { groupId: out.groupId });
    expect(undo.reverted).toBe(4);
    expect(await state()).toEqual(original);

    // Undoing the undo redoes the import.
    await call(owner, 'changes.revertGroup', { groupId: undo.groupId });
    expect(await state()).toEqual(imported);

    // A transcription that changed the status outside the change log blocks the undo.
    await db
      .update(schema.audioSegments)
      .set({ status: 'transcribing' })
      .where(eq(schema.audioSegments.id, audioId));
    const [redo] = await call(owner, 'changes.list', { sessionId: session.id, limit: 1 });
    await failsWith(call(owner, 'changes.revertGroup', { groupId: redo!.groupId! }), 'conflict');
  });

  it('refuses bad input, other sessions, readers and running transcriptions', async () => {
    const { owner, team, show, session } = await studio();
    const base = { sessionId: session.id, mode: 'replace' as const };
    await failsWith(
      call(owner, 'transcript.import', { ...base, format: 'json', content: 'not json' }),
      'bad_request',
    );
    await failsWith(
      call(owner, 'transcript.import', { ...base, format: 'srt', content: 'hello\nworld' }),
      'bad_request',
    );
    await failsWith(
      call(owner, 'transcript.import', { ...base, format: 'json', content: '[]' }),
      'bad_request',
    );
    await failsWith(
      call(owner, 'transcript.import', {
        ...base,
        audioSegmentId: 'aud_missing',
        format: 'srt',
        content: SRT,
      }),
      'not_found',
    );

    const outsider = await makeUser('outsider@example.com');
    await failsWith(
      call(outsider, 'transcript.import', { ...base, format: 'srt', content: SRT }),
      'not_found',
    );
    const reader = await makeUser('reader@example.com');
    await call(owner, 'teams.invite', { teamId: team.id, email: reader.user.email });
    await call(owner, 'teams.setGrant', {
      teamId: team.id,
      userId: reader.user.id,
      showId: show.id,
      access: 'read',
    });
    await failsWith(
      call(reader, 'transcript.import', { ...base, format: 'srt', content: SRT }),
      'forbidden',
    );

    await db.insert(schema.jobs).values({
      id: newId('job'),
      kind: 'transcribe',
      sessionId: session.id,
      payload: { segmentId: 'aud_x' },
    });
    await failsWith(
      call(owner, 'transcript.import', { ...base, format: 'srt', content: SRT }),
      'conflict',
    );
    expect(await call(owner, 'transcript.get', { sessionId: session.id })).toEqual([]);
  });
});
