// Long wiki bodies by upload (wiki.createUpload → bodyUploadId / appendUploadId) and wiki.patch
// `all: true` (#379). Storage is an in-memory map: the PUT itself is the client's business.

import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const stored = vi.hoisted(() => {
  process.env.S3_BUCKET = 'test-bucket';
  process.env.S3_ACCESS_KEY_ID = 'test';
  process.env.S3_SECRET_ACCESS_KEY = 'test';
  process.env.S3_ENDPOINT = 'http://127.0.0.1:9';
  return new Map<string, Uint8Array>();
});
vi.mock('../media/s3.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../media/s3.ts')>()),
  presignUpload: async (key: string) => `http://upload.invalid/${key}`,
  headObject: async (key: string) => {
    const b = stored.get(key);
    return b ? { size: b.length, contentType: 'text/markdown' } : null;
  },
  getObjectBytes: async (key: string) => stored.get(key) ?? null,
  deleteObject: async (key: string) => void stored.delete(key),
}));

const { asAgent, call, failsWith, makeUser, resetDb, setupDb, studio } = await import(
  './harness.ts'
);

beforeAll(setupDb);
beforeEach(() => {
  stored.clear();
  return resetDb();
});

/** What a client's PUT to uploadUrl does. */
function put(uploadUrl: string, text: string) {
  stored.set(uploadUrl.replace('http://upload.invalid/', ''), new TextEncoder().encode(text));
}

describe('wiki body uploads', () => {
  it('saves an uploaded body or appended section once, then the upload is gone', async () => {
    const { owner, show } = await studio();
    const agent = asAgent(owner);
    const up = await call(agent, 'wiki.createUpload', { showId: show.id });
    expect(up.headers).toEqual({ 'Content-Type': 'text/markdown' });

    // Not PUT yet: conflict, nothing saved.
    const save = { showId: show.id, kind: 'person' as const, title: 'Dana' };
    await failsWith(call(agent, 'wiki.upsert', { ...save, bodyUploadId: up.uploadId }), 'conflict');
    put(up.uploadUrl, `${String.fromCharCode(0xfeff)}Host of [[Cold open]].\n`); // a BOM is dropped
    const page = await call(agent, 'wiki.upsert', { ...save, bodyUploadId: up.uploadId });
    expect(page).toMatchObject({ unresolvedLinks: ['Cold open'] });
    expect((await call(owner, 'wiki.get', { pageId: page.id })).bodyMd).toBe(
      'Host of [[Cold open]].\n',
    );
    expect(stored.size).toBe(0);
    await failsWith(call(agent, 'wiki.upsert', { ...save, bodyUploadId: up.uploadId }), 'conflict');
    // Exactly one of bodyMd / bodyUploadId.
    await failsWith(
      call(agent, 'wiki.upsert', { ...save, bodyMd: 'x', bodyUploadId: up.uploadId }),
      'bad_request',
    );
    await failsWith(call(agent, 'wiki.upsert', save as never), 'bad_request');

    const more = await call(agent, 'wiki.createUpload', { showId: show.id });
    put(more.uploadUrl, '## Bits\nThe cold open.');
    await call(agent, 'wiki.patch', { pageId: page.id, appendUploadId: more.uploadId });
    expect((await call(owner, 'wiki.get', { pageId: page.id })).bodyMd).toBe(
      'Host of [[Cold open]].\n## Bits\nThe cold open.',
    );

    // An upload is only usable in its own show; strangers cannot create one.
    const other = await studio();
    const theirs = await call(asAgent(other.owner), 'wiki.createUpload', { showId: other.show.id });
    put(theirs.uploadUrl, 'Not yours.');
    await failsWith(
      call(agent, 'wiki.patch', { pageId: page.id, appendUploadId: theirs.uploadId }),
      'conflict',
    );
    await failsWith(
      call(asAgent(await makeUser('stranger@example.com')), 'wiki.createUpload', {
        showId: show.id,
      }),
      'not_found',
    );
  });

  it('wiki.patch all: true replaces every occurrence, and needs at least one', async () => {
    const { owner, show } = await studio();
    const page = await call(owner, 'wiki.upsert', {
      showId: show.id,
      kind: 'bit',
      title: 'Cold open',
      bodyMd: 'Dana opens. Tom laughs. Dana again.',
    });
    await failsWith(
      call(owner, 'wiki.patch', {
        pageId: page.id,
        edits: [{ find: 'Dana', replace: '[[Dana]]' }],
      }),
      'bad_request',
    );
    await call(owner, 'wiki.patch', {
      pageId: page.id,
      edits: [
        { find: 'Dana', replace: '[[Dana]]', all: true },
        { find: 'Tom', replace: '[[Tom]]' },
      ],
    });
    expect((await call(owner, 'wiki.get', { pageId: page.id })).bodyMd).toBe(
      '[[Dana]] opens. [[Tom]] laughs. [[Dana]] again.',
    );
    await failsWith(
      call(owner, 'wiki.patch', {
        pageId: page.id,
        edits: [{ find: 'Sam', replace: '[[Sam]]', all: true }],
      }),
      'bad_request',
    );
  });
});
