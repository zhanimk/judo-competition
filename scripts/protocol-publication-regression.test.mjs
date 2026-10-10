import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { generateDraw } from '@judo/engine/draw';
const apiDist = process.env.JUDO_API_TEST_DIST ?? '../apps/api/dist';
const apiModule = (path) =>
  import(new URL(`${apiDist}/modules/protocols/${path}.js`, import.meta.url));
const { protocolHash, protocolSourceHash, verifiedProtocolBytes, MAX_PROTOCOL_BYTES } =
  await apiModule('protocol-artifact');
const { ProtocolPublicationsService } = await apiModule('protocol-publications.service');
const { requireTeamResults } = await apiModule('protocol-readiness');
const actor = { id: randomUUID(), role: 'ORGANIZER', sessionId: randomUUID(), tatamiId: null };
function fixture() {
  const entries = ['Али', 'Әлия'].map((firstName, i) => ({
    id: randomUUID(),
    firstName,
    lastName: `QA${i}`,
    birthYear: 2012,
    club: `Клуб ${i}`,
  }));
  const draw = generateDraw(
    'ROUND_ROBIN',
    entries.map(({ id, club }) => ({ id, clubId: club })),
    10,
  );
  return {
    id: randomUUID(),
    name: 'PDF QA',
    city: 'Алматы',
    venue: 'QA',
    startDate: '2026-10-10',
    endDate: '2026-10-10',
    rulesSnapshot: { version: 'custom-2026-v3' },
    rosterRevision: 1,
    protocolRevision: 0,
    ownerId: actor.id,
    publishedAt: new Date('2026-10-10'),
    categories: [
      {
        id: randomUUID(),
        name: 'U15',
        gender: 'MALE',
        birthYearFrom: 2012,
        birthYearTo: 2013,
        minWeightGrams: null,
        maxWeightGrams: 50000,
        durationSeconds: 180,
        format: 'ROUND_ROBIN',
        entries,
        draw: {
          version: 1,
          status: 'CONFIRMED',
          publishedAt: null,
          snapshot: draw,
          contests: [
            {
              id: randomUUID(),
              key: draw.matches[0].id,
              round: 1,
              status: 'ACTIVE',
              whiteEntryId: entries[0].id,
              blueEntryId: entries[1].id,
              winnerEntryId: null,
              resultReason: null,
              state: {
                status: 'RUNNING',
                elapsedMs: 1000,
                receipts: { secret: { actor: 'private' } },
              },
              offlineSessionId: null,
              offlineActorId: null,
              offlineControlGeneration: null,
            },
          ],
        },
      },
    ],
  };
}
const conflict = (code) => (error) => error.getStatus() === 409 && error.message === code;
test('stored bytes require exact size, PDF header, checksum and bounded content', () => {
  const bytes = Buffer.from('%PDF-1.3\nQA\n%%EOF'),
    sha = protocolHash(bytes);
  assert.deepEqual(verifiedProtocolBytes(Uint8Array.from(bytes), bytes.length, sha), bytes);
  for (const [content, size, hash] of [
    [Buffer.from('not a PDF'), 9, protocolHash(Buffer.from('not a PDF'))],
    [bytes, bytes.length - 1, sha],
    [bytes, bytes.length, 'a'.repeat(64)],
    [bytes, MAX_PROTOCOL_BYTES + 1, sha],
  ])
    assert.throws(
      () => verifiedProtocolBytes(content, size, hash),
      conflict('PROTOCOL_ARTIFACT_INVALID'),
    );
});
test('source fingerprint changes after names or confirmed result changes without exposing receipts', () => {
  const t = fixture(),
    before = protocolSourceHash(t, 'DRAW'),
    name = structuredClone(t);
  name.categories[0].entries[0].lastName = 'Исправлено';
  assert.notEqual(protocolSourceHash(name, 'DRAW'), before);
  const confirmed = structuredClone(t);
  Object.assign(confirmed.categories[0].draw.contests[0], {
    status: 'CONFIRMED',
    winnerEntryId: t.categories[0].entries[0].id,
    resultReason: 'IPPON',
  });
  assert.notEqual(protocolSourceHash(confirmed, 'DRAW'), before);
  const next = structuredClone(confirmed);
  next.categories[0].draw.contests[0].state.receipts = { newActor: { secret: 'private' } };
  assert.equal(protocolSourceHash(next, 'DRAW'), protocolSourceHash(confirmed, 'DRAW'));
});
test('running ticks do not stale a draw snapshot; participants do not depend on sporting results', () => {
  const t = fixture(),
    next = structuredClone(t);
  next.categories[0].draw.contests[0].state.elapsedMs = 99999;
  assert.equal(protocolSourceHash(t, 'DRAW'), protocolSourceHash(next, 'DRAW'));
  Object.assign(next.categories[0].draw.contests[0], {
    status: 'CONFIRMED',
    winnerEntryId: t.categories[0].entries[0].id,
    resultReason: 'IPPON',
  });
  assert.equal(protocolSourceHash(t, 'PARTICIPANTS'), protocolSourceHash(next, 'PARTICIPANTS'));
  next.categories[0].draw.version = 2;
  assert.notEqual(
    protocolSourceHash(t, 'PARTICIPANTS'),
    protocolSourceHash(next, 'PARTICIPANTS'),
    'Printed draw version belongs to participant metadata',
  );
});
test('a v4 manual three-way review cannot produce a publishable final team document', () => {
  const t = fixture(),
    category = t.categories[0];
  category.entries.push({
    ...category.entries[0],
    id: randomUUID(),
    club: 'Клуб 3',
    lastName: 'QA3',
  });
  const draw = generateDraw(
    'ROUND_ROBIN',
    category.entries.map(({ id, club }) => ({ id, clubId: club })),
    5,
  );
  Object.assign(draw, { tieBreak: 'REMATCH', tieRanking: 'WINS_ONLY', tieMany: 'ADMIN_REVIEW' });
  category.draw.snapshot = draw;
  category.draw.contests = draw.matches.map((match) => {
    const white = match.white.entryId,
      blue = match.blue.entryId;
    const wi = category.entries.findIndex((row) => row.id === white),
      bi = category.entries.findIndex((row) => row.id === blue);
    return {
      ...category.draw.contests[0],
      id: randomUUID(),
      key: match.id,
      round: match.round,
      status: 'CONFIRMED',
      whiteEntryId: white,
      blueEntryId: blue,
      winnerEntryId: (wi + 1) % 3 === bi ? white : blue,
      resultReason: 'IPPON',
    };
  });
  assert.throws(
    () => requireTeamResults([category]),
    (error) =>
      error.getStatus() === 409 &&
      error.getResponse().message === 'TEAMS_NOT_READY' &&
      error.getResponse().categories[0].reason === 'RESULTS_UNRESOLVED',
  );
});
function harness({
  expired = false,
  stale = false,
  corrupt = false,
  foreignId = false,
  published = false,
} = {}) {
  let saved = { t: fixture(), audits: [], outbox: [], commands: [], locks: [], artifacts: [] };
  const bytes = Buffer.from('%PDF-1.3\nQA\n%%EOF');
  const artifact = {
    id: randomUUID(),
    tournamentId: saved.t.id,
    version: 1,
    kind: 'DRAW',
    lang: 'ru',
    scope: 'ALL',
    categoryIds: saved.t.categories.map((c) => c.id),
    source: {
      hash: protocolSourceHash(saved.t, 'DRAW'),
      capturedAt: new Date().toISOString(),
      rosterRevision: 1,
      tournamentName: saved.t.name,
      categories: saved.t.categories.map((c) => ({ id: c.id, name: c.name, drawVersion: 1 })),
    },
    sha256: protocolHash(bytes),
    byteSize: bytes.length,
    bytes: corrupt ? Buffer.from('%PDF-BROKEN') : bytes,
    createdById: actor.id,
    createdAt: new Date(),
    publishedAt: published ? new Date() : null,
  };
  saved.artifacts.push(artifact);
  if (stale) saved.t.categories[0].entries[0].firstName = 'Changed';
  const select = (row, fields) =>
    fields
      ? Object.fromEntries(
          Object.keys(fields)
            .filter((k) => fields[k])
            .map((k) => [k, row[k]]),
        )
      : row;
  const matches = (row, where = {}) =>
    (!where.id || row.id === where.id) &&
    (!where.tournamentId || row.tournamentId === where.tournamentId) &&
    (!where.publishedAt || row.publishedAt !== null) &&
    (!where.version || row.version < where.version.lt);
  const db = {
    $transaction: async (callback) => {
      const working = structuredClone(saved),
        tx = {
          $queryRaw: async (strings, ...values) => {
            working.locks.push(strings.join('?'));
            return [];
          },
          session: {
            findUnique: async () =>
              expired
                ? null
                : {
                    userId: actor.id,
                    user: { id: actor.id, role: actor.role },
                    expiresAt: new Date('2099-01-01'),
                    invitationId: null,
                  },
          },
          tournament: {
            findUnique: async () => working.t,
            update: async ({ data }) => Object.assign(working.t, data),
          },
          protocolCommand: {
            findUnique: async ({ where }) =>
              working.commands.find((c) => c.id === where.id) ?? null,
            findFirst: async () => (foreignId ? { id: randomUUID() } : null),
            create: async ({ data }) => {
              working.commands.push(data);
              return data;
            },
          },
          tournamentCommand: { findFirst: async () => null },
          rosterCommand: { findFirst: async () => null },
          tournamentCommand: { findFirst: async () => null },
          accessCommand: { findFirst: async () => null },
          drawCommand: { findFirst: async () => null },
          matchEvent: { findFirst: async () => null },
          protocolArtifact: {
            findFirst: async ({ where, select: fields }) => {
              const row = working.artifacts.find((row) => matches(row, where));
              return row ? select(row, fields) : null;
            },
            findUniqueOrThrow: async ({ where, select: fields }) =>
              select(
                working.artifacts.find((row) => row.id === where.id),
                fields,
              ),
            update: async ({ where, data, select: fields }) => {
              const row = working.artifacts.find((a) => a.id === where.id);
              Object.assign(row, data);
              return select(row, fields);
            },
            findMany: async ({ where, select: fields, take }) =>
              working.artifacts
                .filter((row) => matches(row, where))
                .sort((a, b) => b.version - a.version)
                .slice(0, take)
                .map((row) => select(row, fields)),
          },
          auditEvent: { create: async ({ data }) => working.audits.push(data) },
          liveOutbox: { create: async ({ data }) => working.outbox.push(data) },
        };
      const response = await callback(tx);
      saved = working;
      return response;
    },
  };
  const service = new ProtocolPublicationsService(db, { owner: async () => {} });
  return {
    service,
    artifact,
    tournament: saved.t.id,
    state: () => structuredClone(saved),
    command: (type = 'PUBLISH') => ({
      id: randomUUID(),
      expectedRevision: saved.t.protocolRevision,
      type,
      reason: 'QA publication review',
      sha256: artifact.sha256,
    }),
    mutate: (fn) => fn(saved),
  };
}
test('publish is a single audited outbox transaction; exact replay survives later unpublication', async () => {
  const h = harness(),
    command = h.command(),
    first = await h.service.visibility(h.tournament, h.artifact.id, command, actor);
  assert.equal(first.revision, 1);
  assert.ok(first.artifact.publishedAt);
  assert.equal(h.state().audits.length, 1);
  assert.equal(h.state().outbox.length, 1);
  await h.service.visibility(h.tournament, h.artifact.id, h.command('UNPUBLISH'), actor);
  assert.deepEqual(await h.service.visibility(h.tournament, h.artifact.id, command, actor), first);
  assert.equal(h.state().t.protocolRevision, 2);
  assert.equal(h.state().artifacts[0].publishedAt, null);
  assert.equal(h.state().audits.length, 2);
  assert.equal(h.state().outbox.length, 2);
  const locks = h.state().locks;
  assert.match(locks[0], /Tournament/);
  assert.match(locks[1], /Tatami/);
  assert.match(locks[2], /Session/);
});
test('fresh Session loss denies writes and replay before any metadata is changed', async () => {
  const h = harness({ expired: true }),
    before = h.state();
  await assert.rejects(
    h.service.visibility(h.tournament, h.artifact.id, h.command(), actor),
    (error) => error.getStatus() === 401,
  );
  assert.deepEqual(h.state(), before);
});
test('stale source and corrupt stored bytes cannot be newly published', async () => {
  for (const [opts, code] of [
    [{ stale: true }, 'PROTOCOL_SOURCE_CHANGED'],
    [{ corrupt: true }, 'PROTOCOL_ARTIFACT_INVALID'],
  ]) {
    const h = harness(opts),
      before = h.state();
    await assert.rejects(
      h.service.visibility(h.tournament, h.artifact.id, h.command(), actor),
      conflict(code),
    );
    assert.deepEqual(h.state(), before);
  }
});
test('visibility review hash, revision and global command ID guards do not mutate publication', async () => {
  for (const [options, change, code] of [
    [{}, (command) => ({ ...command, sha256: 'a'.repeat(64) }), 'PROTOCOL_REVIEW_CHANGED'],
    [{}, (command) => ({ ...command, expectedRevision: 99 }), 'PROTOCOL_VERSION_CONFLICT'],
    [{ foreignId: true }, (command) => command, 'COMMAND_ID_REUSED'],
  ]) {
    const h = harness(options),
      before = h.state();
    await assert.rejects(
      h.service.visibility(h.tournament, h.artifact.id, change(h.command()), actor),
      conflict(code),
    );
    assert.deepEqual(h.state(), before);
  }
});
test('guest history includes only published headers and marks a stale version without disclosing bytes or actor', async () => {
  const h = harness({ published: true, stale: true }),
    history = await h.service.history(h.tournament, null);
  assert.equal(history.artifacts.length, 1);
  assert.equal(history.artifacts[0].sourceCurrent, false);
  assert.equal(history.artifacts[0].latest, true);
  assert.equal('bytes' in history.artifacts[0], false);
  assert.equal('createdById' in history.artifacts[0], false);
  await h.service.visibility(h.tournament, h.artifact.id, h.command('UNPUBLISH'), actor);
  assert.equal((await h.service.history(h.tournament, null)).artifacts.length, 0);
});
test('latest labels compare the full visible history even on an older paginated page', async () => {
  const h = harness({ published: true });
  h.mutate((state) => {
    state.artifacts.push({ ...structuredClone(state.artifacts[0]), id: randomUUID(), version: 2 });
    state.artifacts.push({
      ...structuredClone(state.artifacts[0]),
      id: randomUUID(),
      version: 3,
      publishedAt: null,
    });
  });
  const older = await h.service.history(h.tournament, null, 2);
  assert.equal(older.artifacts.length, 1);
  assert.equal(older.artifacts[0].latest, false);
  const guest = await h.service.history(h.tournament, null);
  assert.equal(
    guest.artifacts.find((row) => row.version === 2).latest,
    true,
    'Private version is not the latest guest-visible publication',
  );
  const admin = await h.service.history(h.tournament, actor);
  assert.equal(admin.artifacts.find((row) => row.version === 3).latest, true);
});
