import assert from 'node:assert/strict';
import test from 'node:test';
import { ApiError } from '../src/features/tournaments/api.ts';
import {
  clearPendingProtocol,
  deliverProtocol,
  pendingProtocolJson,
  readPendingProtocol,
  savePendingProtocol,
  validProtocolHistory,
  type PendingProtocol,
  type ProtocolArtifact,
} from '../src/features/protocols/protocol-model.ts';

const tournamentId = '11111111-1111-4111-8111-111111111111';
const commandId = '22222222-2222-4222-8222-222222222222';
const artifactId = '33333333-3333-4333-8333-333333333333';
const categoryId = '44444444-4444-4444-8444-444444444444';
function artifact(): ProtocolArtifact {
  return {
    id: artifactId,
    tournamentId,
    version: 1,
    kind: 'DRAW',
    lang: 'ru',
    scope: 'ALL',
    categoryIds: [categoryId],
    sha256: 'a'.repeat(64),
    byteSize: 200,
    createdAt: '2026-10-10T00:00:00Z',
    publishedAt: null,
    sourceCurrent: true,
    source: {
      hash: 'b'.repeat(64),
      capturedAt: '2026-10-10T00:00:00Z',
      rosterRevision: 1,
      tournamentName: 'QA',
      categories: [{ id: categoryId, name: 'U15', drawVersion: 1 }],
    },
  };
}
function create(): PendingProtocol {
  return {
    tournamentId,
    action: 'CREATE',
    body: { id: commandId, expectedRevision: 0, reason: 'QA version', kind: 'DRAW', lang: 'ru' },
  };
}
function storage() {
  const values = new Map<string, string>();
  return {
    values,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
    removeItem: (key: string) => {
      values.delete(key);
    },
  };
}

test('a lost CREATE retains the original command across reload and accepts a distinct server artifact ID', async () => {
  const store = storage(),
    pending = create();
  savePendingProtocol(store, pending);
  assert.equal(
    (
      await deliverProtocol(pending, async () => {
        throw new TypeError('network');
      })
    ).kind,
    'retry',
  );
  const restored = readPendingProtocol(store, tournamentId)!;
  assert.deepEqual(restored, pending);
  assert.equal(pendingProtocolJson(store, tournamentId), JSON.stringify(pending));
  const result = await deliverProtocol(restored, async (path, body) => {
    assert.equal(path, `/tournaments/${tournamentId}/protocols`);
    assert.deepEqual(body, pending.body);
    return { revision: 1, artifact: artifact() };
  });
  assert.equal(result.kind, 'success');
  assert.notEqual(artifactId, commandId);
  clearPendingProtocol(store, restored);
  assert.equal(readPendingProtocol(store, tournamentId), null);
});
test('sender mutation cannot rewrite the saved retry packet', async () => {
  const pending = create(),
    before = structuredClone(pending);
  await deliverProtocol(pending, async (_path, body) => {
    (body as { reason: string }).reason = 'changed';
    throw new TypeError('lost response');
  });
  assert.deepEqual(pending, before);
});
test('a different pending action cannot replace or clear the original', () => {
  const store = storage(),
    pending = create();
  savePendingProtocol(store, pending);
  const other = structuredClone(pending);
  other.body.id = artifactId;
  assert.throws(() => savePendingProtocol(store, other), /PROTOCOL_PENDING_EXISTS/);
  assert.throws(() => clearPendingProtocol(store, other), /PROTOCOL_PENDING_EXISTS/);
  assert.deepEqual(readPendingProtocol(store, tournamentId), pending);
});
test('unknown auth, rate limit, server failure and reused ID responses retain exact retry', async () => {
  for (const [code, status] of [
    ['AUTH_REQUIRED', 401],
    ['FORBIDDEN', 403],
    ['RATE_LIMIT', 429],
    ['SERVER', 500],
    ['COMMAND_ID_REUSED', 409],
  ] as const)
    assert.equal(
      (
        await deliverProtocol(create(), async () => {
          throw new ApiError(code, status);
        })
      ).kind,
      'retry',
      code,
    );
});
test('known source/version rejection finishes the packet without silently changing its revision', async () => {
  const pending = create(),
    before = structuredClone(pending);
  for (const code of ['PROTOCOL_SOURCE_CHANGED', 'PROTOCOL_VERSION_CONFLICT'])
    assert.equal(
      (
        await deliverProtocol(pending, async () => {
          throw new ApiError(code, 409);
        })
      ).kind,
      'rejected',
    );
  assert.deepEqual(pending, before);
});
test('malformed or wrong-language CREATE receipts stay pending', async () => {
  for (const mutate of [
    (row: ProtocolArtifact) => {
      row.lang = 'kk';
    },
    (row: ProtocolArtifact) => {
      row.sha256 = 'bad';
    },
    (row: ProtocolArtifact) => {
      row.scope = 'SELECTED';
    },
    (row: ProtocolArtifact) => {
      row.publishedAt = '2026-10-10T00:00:00Z';
    },
  ]) {
    const row = artifact();
    mutate(row);
    assert.equal(
      (await deliverProtocol(create(), async () => ({ revision: 1, artifact: row }))).kind,
      'retry',
    );
  }
});
test('publish receipts bind artifact ID and hash while permitting historical source status', async () => {
  const row = artifact(),
    command: PendingProtocol = {
      tournamentId,
      action: 'PUBLISH',
      artifactId,
      artifactSnapshot: row,
      body: {
        id: commandId,
        expectedRevision: 1,
        type: 'PUBLISH',
        reason: 'Reviewed PDF',
        sha256: row.sha256,
      },
    };
  const published = { ...row, publishedAt: '2026-10-10T00:00:00Z', sourceCurrent: false };
  assert.equal(
    (await deliverProtocol(command, async () => ({ revision: 2, artifact: published }))).kind,
    'success',
  );
  assert.equal(
    (
      await deliverProtocol(command, async () => ({
        revision: 2,
        artifact: { ...published, sha256: 'c'.repeat(64) },
      }))
    ).kind,
    'retry',
  );
});
test('unpublish cannot be acknowledged by a still-published or unrelated file', async () => {
  const row = { ...artifact(), publishedAt: '2026-10-10T00:00:00Z' },
    command: PendingProtocol = {
      tournamentId,
      action: 'UNPUBLISH',
      artifactId,
      artifactSnapshot: row,
      body: {
        id: commandId,
        expectedRevision: 1,
        type: 'UNPUBLISH',
        reason: 'Retract PDF',
        sha256: row.sha256,
      },
    };
  assert.equal(
    (await deliverProtocol(command, async () => ({ revision: 2, artifact: row }))).kind,
    'retry',
  );
  assert.equal(
    (
      await deliverProtocol(command, async () => ({
        revision: 2,
        artifact: { ...row, publishedAt: null },
      }))
    ).kind,
    'success',
  );
});
test('history rejects cross-tournament and duplicated artifact metadata', () => {
  const history = {
    revision: 2,
    tournamentPublished: true,
    artifacts: [artifact()],
    nextBeforeVersion: null,
  };
  assert.equal(validProtocolHistory(history, tournamentId), true);
  assert.equal(
    validProtocolHistory({ ...history, artifacts: [artifact(), artifact()] }, tournamentId),
    false,
  );
  assert.equal(
    validProtocolHistory(
      { ...history, artifacts: [{ ...artifact(), tournamentId: artifactId }] },
      tournamentId,
    ),
    false,
  );
});
test('corrupt restored visibility commands and unexpected payload fields fail closed', () => {
  const store = storage(),
    pending = create();
  savePendingProtocol(store, pending);
  const [key] = store.values.keys();
  store.setItem(key, JSON.stringify({ ...pending, body: { ...pending.body, publishedAt: 'now' } }));
  assert.throws(() => readPendingProtocol(store, tournamentId), /PROTOCOL_STORAGE_INVALID/);
});
