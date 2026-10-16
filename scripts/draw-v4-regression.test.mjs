import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import {
  approveAdditionalRound,
  createRoundRobin,
  generateDraw,
  resolveMatches,
} from '@judo/engine/draw';

const dist = process.env.JUDO_TEST_API_DIST ?? 'apps/api/dist';
const load = (path) => import(pathToFileURL(resolve(dist, path)).href);
const { DrawsService } = await load('modules/draws/draws.service.js');
const { TiebreakCommandDto, DrawPreviewDto, DrawConfirmDto, DrawPublicationDto } = await load(
  'modules/draws/draws.dto.js',
);
const { propagateDraw, tournamentComplete } = await load('modules/draws/draw-propagation.js');
const { readyQueue, unfinishedRound } = await load('modules/tatamis/queue.js');

const owner = {
  id: randomUUID(),
  role: 'ORGANIZER',
  sessionId: randomUUID(),
  name: 'QA',
  tatamiId: null,
};
const other = {
  id: randomUUID(),
  role: 'SUPER_ADMIN',
  sessionId: randomUUID(),
  name: 'Other QA',
  tatamiId: null,
};
const tournamentId = randomUUID(),
  categoryId = randomUUID(),
  matId = randomUUID();
const entries = (count) =>
  Array.from({ length: count }, (_, i) => ({ id: randomUUID(), clubId: 'club' + i }));
const v4 = (draw) => ({
  ...draw,
  tieBreak: 'REMATCH',
  tieRanking: 'WINS_ONLY',
  tieMany: 'ADMIN_REVIEW',
});
const direct = (match) => [match.white.entryId, match.blue.entryId];
const cycle = (matches, members) =>
  Object.fromEntries(
    matches.map((match) => {
      const [a, b] = direct(match),
        delta = (members.indexOf(b) - members.indexOf(a) + members.length) % members.length;
      return [match.id, delta <= (members.length - 1) / 2 ? a : b];
    }),
  );
const minimum = (matches) =>
  Object.fromEntries(matches.map((match) => [match.id, direct(match).sort()[0]]));
const errorIs = (status, message) => (error) =>
  error.getStatus() === status && error.message === message;

function harness(draw = v4(createRoundRobin(entries(3), 12)), results) {
  results ??= cycle(
    draw.matches,
    draw.positions.map((entry) => entry.id),
  );
  const recordId = randomUUID();
  const resolved = resolveMatches(draw, results);
  let saved = {
    record: {
      id: recordId,
      categoryId,
      version: 1,
      status: 'CONFIRMED',
      snapshot: draw,
      publicationRevision: 0,
      publishedAt: null,
    },
    rows: resolved.map((match, i) => ({
      id: randomUUID(),
      drawId: recordId,
      key: match.id,
      round: match.round,
      whiteEntryId: match.whiteEntryId ?? null,
      blueEntryId: match.blueEntryId ?? null,
      winnerEntryId: match.winnerEntryId ?? null,
      status: match.winnerEntryId ? 'CONFIRMED' : match.ready ? 'READY' : 'WAITING',
      revision: 0,
      tatamiId: match.ready || match.winnerEntryId ? matId : null,
      queueOrder: i + 1,
      state: null,
      confirmedAt: match.winnerEntryId ? new Date(0) : null,
      endedAt: match.winnerEntryId ? new Date(0) : null,
      offlineSessionId: null,
      offlineActorId: null,
      offlineControlGeneration: null,
      updatedAt: new Date(0),
      clockAnchorMs: null,
      clockEpoch: null,
    })),
    category: {
      id: categoryId,
      tournamentId,
      homeTatamiId: matId,
      name: 'QA U15 -30',
      format: draw.algorithm === 'custom-round-robin-v1' ? 'ROUND_ROBIN' : 'MIXED',
      durationSeconds: 180,
    },
    roster: draw.positions
      .filter(Boolean)
      .map((entry, i) => ({
        id: entry.id,
        athleteId: entry.id,
        categoryId,
        firstName: 'QA',
        lastName: 'Athlete-' + i,
        birthYear: 2012,
        club: 'Club-' + i,
        clubId: entry.clubId,
        createdAt: new Date(0),
        archivedAt: null,
      }))
      .sort((a, b) => a.id.localeCompare(b.id)),
    tournament: {
      id: tournamentId,
      ownerId: owner.id,
      status: 'RUNNING',
      rulesSnapshot: {
        shidoLimit: 3,
        wazaForIppon: 2,
        enabledScores: ['YUKO', 'WAZA_ARI', 'IPPON'],
        holdThresholds: [
          { ms: 5000, score: 'YUKO' },
          { ms: 10000, score: 'WAZA_ARI' },
          { ms: 20000, score: 'IPPON' },
        ],
        version: 'custom-2026-v4',
        drawPolicy: 'REPECHAGE_ONLY',
        tieBreak: 'REMATCH',
        tieRanking: 'WINS_ONLY',
        tieMany: 'ADMIN_REVIEW',
      },
    },
    commands: [],
    events: [],
    audit: [],
    outbox: [],
    collisions: [],
    sessions: [owner, other].map((user) => ({
      id: user.sessionId,
      userId: user.id,
      invitationId: null,
      expiresAt: new Date(Date.now() + 3600000),
      user: { id: user.id, role: user.role },
    })),
  };
  let chain = Promise.resolve();
  const locks = [],
    queries = [],
    notices = [];
  const txFor = (data) => ({
    $queryRaw: async (strings) => {
      locks.push(strings.join('?'));
      return [];
    },
    session: {
      findUnique: async ({ where }) =>
        structuredClone(data.sessions.find((session) => session.id === where.id) ?? null),
    },
    tournament: {
      findUnique: async () => structuredClone(data.tournament),
      findUniqueOrThrow: async () => structuredClone(data.tournament),
      update: async ({ data: patch }) => {
        Object.assign(data.tournament, structuredClone(patch));
        return structuredClone(data.tournament);
      },
    },
    entry: { findMany: async () => structuredClone(data.roster) },
    category: {
      findUniqueOrThrow: async () =>
        structuredClone({ ...data.category, tournament: data.tournament }),
      findMany: async () => [
        {
          ...data.category,
          entries: data.roster,
          draw: { ...data.record, contests: data.rows },
        },
      ],
    },
    drawRecord: {
      findUnique: async ({ include }) =>
        data.record &&
        structuredClone({ ...data.record, ...(include ? { contests: data.rows } : {}) }),
      findUniqueOrThrow: async ({ include }) =>
        structuredClone({ ...data.record, ...(include ? { contests: data.rows } : {}) }),
      findMany: async (args) => {
        queries.push({ delegate: 'drawRecord.findMany', args });
        return structuredClone(
          data.record &&
            args.where.id.in.includes(data.record.id) &&
            data.record.status === args.where.status
            ? [{ ...data.record, contests: data.rows }]
            : [],
        );
      },
      create: async ({ data: updates }) => {
        data.record = {
          ...updates,
          id: recordId,
          version: 1,
          publicationRevision: 0,
          publishedAt: null,
        };
        return structuredClone(data.record);
      },
      update: async ({ data: updates }) => {
        data.record = {
          ...data.record,
          ...updates,
          version: data.record.version + (updates.version?.increment ?? 0),
          publicationRevision:
            data.record.publicationRevision + (updates.publicationRevision?.increment ?? 0),
        };
        return structuredClone(data.record);
      },
    },
    contest: {
      findUniqueOrThrow: async ({ where }) =>
        structuredClone(
          data.rows.find((row) =>
            where.id
              ? row.id === where.id
              : row.drawId === where.drawId_key.drawId && row.key === where.drawId_key.key,
          ),
        ),
      findMany: async (args) => {
        queries.push({ delegate: 'contest.findMany', args });
        const { where, include } = args;
        return structuredClone(
          data.rows
            .filter(
              (row) =>
                (!where.drawId || row.drawId === where.drawId) &&
                (!where.status || row.status === where.status) &&
                (!where.tatamiId || row.tatamiId === where.tatamiId),
            )
            .map((row) =>
              include
                ? {
                    ...row,
                    draw: {
                      ...data.record,
                      contests: data.rows,
                      category: {
                        ...data.category,
                        birthYearFrom: 2012,
                        birthYearTo: 2013,
                        maxWeightGrams: 30000,
                        minWeightGrams: null,
                        entries: data.roster,
                      },
                    },
                  }
                : row,
            ),
        );
      },
      aggregate: async ({ _min }) =>
        _min
          ? {
              _min: {
                round:
                  data.rows
                    .filter((row) => row.status !== 'CONFIRMED')
                    .reduce((n, row) => Math.min(n, row.round), Infinity) === Infinity
                    ? null
                    : Math.min(
                        ...data.rows
                          .filter((row) => row.status !== 'CONFIRMED')
                          .map((row) => row.round),
                      ),
              },
            }
          : { _max: { queueOrder: Math.max(0, ...data.rows.map((row) => row.queueOrder ?? 0)) } },
      update: async ({ where, data: updates }) => {
        const row = data.rows.find((row) => row.id === where.id);
        Object.assign(row, updates, {
          revision: row.revision + (updates.revision?.increment ?? 0),
        });
        return structuredClone(row);
      },
      create: async ({ data: updates }) => {
        const row = {
          ...updates,
          id: randomUUID(),
          revision: 0,
          state: null,
          winnerEntryId: null,
          confirmedAt: null,
          endedAt: null,
          offlineSessionId: null,
          offlineActorId: null,
          offlineControlGeneration: null,
          updatedAt: new Date(0),
        };
        data.rows.push(row);
        return structuredClone(row);
      },
      createMany: async ({ data: updates }) => {
        for (const update of updates)
          data.rows.push({
            ...update,
            id: randomUUID(),
            revision: 0,
            tatamiId: null,
            queueOrder: null,
            state: null,
            winnerEntryId: null,
            confirmedAt: null,
            endedAt: null,
            offlineSessionId: null,
            offlineActorId: null,
            offlineControlGeneration: null,
            clockAnchorMs: null,
            clockEpoch: null,
            updatedAt: new Date(0),
          });
        return { count: updates.length };
      },
    },
    drawCommand: {
      findUnique: async ({ where }) =>
        structuredClone(data.commands.find((command) => command.id === where.id) ?? null),
      findFirst: async ({ where }) =>
        data.commands.find((command) => where.id.in.includes(command.id)) ?? null,
      create: async ({ data: command }) => {
        data.commands.push(structuredClone(command));
      },
    },
    rosterCommand: { findFirst: async () => null },
    tournamentCommand: { findFirst: async () => null },
    accessCommand: { findFirst: async () => null },
    protocolCommand: {
      findFirst: async ({ where }) =>
        data.collisions.find((id) => where.id.in.includes(id)) ? { id: 'collision' } : null,
    },
    matchEvent: {
      findFirst: async () => null,
      create: async ({ data: event }) => {
        data.events.push(structuredClone(event));
      },
    },
    tatami: { update: async () => ({}) },
    auditEvent: {
      create: async ({ data: event }) => {
        if (data.syntheticAuditFailure) throw new Error('synthetic audit failure');
        data.audit.push(structuredClone(event));
      },
    },
    liveOutbox: {
      create: async ({ data: event }) => {
        data.outbox.push(structuredClone(event));
      },
    },
  });
  const db = {
    category: { findUnique: async () => structuredClone(saved.category) },
    $transaction: async (callback) => {
      const operation = chain.then(async () => {
        const staged = structuredClone(saved),
          response = await callback(txFor(staged));
        saved = staged;
        return response;
      });
      chain = operation.catch(() => {});
      return operation;
    },
  };
  const service = new DrawsService({ notify: (event) => notices.push(event) }, db, {
    owner: async () => {},
  });
  return {
    service,
    locks,
    queries,
    notices,
    snapshot: () => structuredClone(saved),
    mutate: (fn) => fn(saved),
    tx: () => txFor(saved),
    command: async (user = owner) => {
      const impact = await service.tiebreakImpact(categoryId, user),
        review = impact.reviews[0];
      assert.ok(review);
      const { parent, pool, members, procedure, impactToken } = review;
      return {
        id: randomUUID(),
        expectedVersion: impact.expectedVersion,
        reason: 'Approved QA additional circle',
        parent,
        pool,
        members: [...members],
        procedure,
        impactToken,
      };
    },
  };
}

test('manual procedure DTO requires UUID, exact safe version/token, cohort and explicit reason', async () => {
  const h = harness(),
    valid = await h.command();
  assert.equal((await validate(plainToInstance(TiebreakCommandDto, valid))).length, 0);
  for (const updates of [
    { id: undefined },
    { expectedVersion: 0 },
    { expectedVersion: 1.5 },
    { expectedVersion: '1' },
    { impactToken: 'old' },
    { reason: 'a' },
    { procedure: 'LOT' },
    { members: valid.members.slice(1) },
    { members: [valid.members[0], valid.members[0], valid.members[1]] },
    { parent: '' },
  ])
    assert.ok(
      (await validate(plainToInstance(TiebreakCommandDto, { ...valid, ...updates }))).length > 0,
    );
});

test('preview, confirmation and publication DTOs require durable IDs and exact numeric versions', async () => {
  for (const [Dto, valid, field] of [
    [DrawPreviewDto, { id: randomUUID(), expectedVersion: 0 }, 'expectedVersion'],
    [DrawConfirmDto, { id: randomUUID(), version: 1 }, 'version'],
    [
      DrawPublicationDto,
      { id: randomUUID(), expectedRevision: 0, published: true },
      'expectedRevision',
    ],
  ]) {
    assert.equal((await validate(plainToInstance(Dto, valid))).length, 0);
    for (const updates of [
      { id: undefined },
      { id: 'old-id' },
      { [field]: undefined },
      { [field]: -1 },
      { [field]: 1.5 },
      { [field]: '1' },
      { [field]: Number.MAX_SAFE_INTEGER + 1 },
    ])
      assert.ok((await validate(plainToInstance(Dto, { ...valid, ...updates }))).length > 0);
  }
  assert.ok(
    (await validate(plainToInstance(DrawConfirmDto, { id: randomUUID(), version: 0 }))).length > 0,
  );
  assert.ok(
    (
      await validate(
        plainToInstance(DrawPublicationDto, {
          id: randomUUID(),
          expectedRevision: 0,
          published: 'true',
        }),
      )
    ).length > 0,
  );
});

function previewHarness() {
  const h = harness(v4(createRoundRobin(entries(3), 9)), {});
  h.mutate((data) => {
    data.record = null;
    data.rows = [];
    data.tournament.status = 'DRAFT';
  });
  return h;
}

test('lost preview responses preserve seed/version and their historical receipt never regenerates a confirmed draw', async () => {
  const h = previewHarness(),
    dto = { id: randomUUID(), expectedVersion: 0 };
  const [first, retry] = await Promise.all([
    h.service.preview(categoryId, dto, owner),
    h.service.preview(categoryId, dto, owner),
  ]);
  assert.deepEqual(retry, first);
  assert.equal(first.version, 1);
  assert.equal(first.snapshot.tieRanking, 'WINS_ONLY');
  assert.equal(first.snapshot.tieMany, 'ADMIN_REVIEW');
  assert.equal(h.snapshot().commands.length, 1);
  assert.equal(h.snapshot().audit.length, 1);
  assert.equal(h.snapshot().outbox.length, 1);
  const before = h.snapshot();
  await assert.rejects(
    h.service.preview(categoryId, { ...dto, id: randomUUID() }, owner),
    errorIs(409, 'DRAW_STALE'),
  );
  assert.deepEqual(h.snapshot(), before);
  await h.service.confirm(categoryId, { id: randomUUID(), version: first.version }, owner);
  const confirmed = h.snapshot();
  assert.deepEqual(await h.service.preview(categoryId, dto, owner), first);
  assert.deepEqual(h.snapshot(), confirmed);
  await assert.rejects(
    h.service.preview(categoryId, { ...dto, expectedVersion: 1 }, owner),
    errorIs(409, 'COMMAND_ID_REUSED'),
  );
  assert.deepEqual(h.snapshot(), confirmed);
});

test('lost confirmation responses create contests once and replay the original saved rows after later sporting changes', async () => {
  const h = previewHarness(),
    preview = await h.service.preview(categoryId, { id: randomUUID(), expectedVersion: 0 }, owner);
  const dto = { id: randomUUID(), version: preview.version };
  const [first, retry] = await Promise.all([
    h.service.confirm(categoryId, dto, owner),
    h.service.confirm(categoryId, dto, owner),
  ]);
  assert.deepEqual(retry, first);
  assert.equal(first.status, 'CONFIRMED');
  assert.equal(first.contests.length, 3);
  assert.equal(h.snapshot().rows.length, 3);
  assert.equal(h.snapshot().audit.filter((event) => event.action === 'DRAW_CONFIRMED').length, 1);
  h.mutate((data) => {
    data.record.version += 1;
    Object.assign(data.rows[0], {
      status: 'ACTIVE',
      state: { status: 'PAUSED' },
      revision: 2,
      tatamiId: matId,
    });
  });
  const later = h.snapshot();
  assert.deepEqual(await h.service.confirm(categoryId, dto, owner), first);
  assert.deepEqual(h.snapshot(), later);
  await assert.rejects(
    h.service.confirm(categoryId, { ...dto, id: randomUUID() }, owner),
    errorIs(409, 'DRAW_STALE'),
  );
  assert.deepEqual(h.snapshot(), later);
});

test('historical publication receipt cannot republish after hiding and fresh no-op commands still require current publication revision', async () => {
  const h = harness(),
    publish = { id: randomUUID(), expectedRevision: 0, published: true };
  const [first, retry] = await Promise.all([
    h.service.publication(categoryId, publish, owner),
    h.service.publication(categoryId, publish, owner),
  ]);
  assert.deepEqual(retry, first);
  assert.equal(first.publicationRevision, 1);
  assert.ok(first.publishedAt);
  const hidden = await h.service.publication(
    categoryId,
    { id: randomUUID(), expectedRevision: 1, published: false },
    owner,
  );
  assert.equal(hidden.publicationRevision, 2);
  assert.equal(hidden.publishedAt, null);
  const later = h.snapshot();
  assert.deepEqual(await h.service.publication(categoryId, publish, owner), first);
  assert.deepEqual(h.snapshot(), later);
  await assert.rejects(
    h.service.publication(
      categoryId,
      { id: randomUUID(), expectedRevision: 0, published: false },
      owner,
    ),
    errorIs(409, 'PUBLICATION_STALE'),
  );
  assert.deepEqual(h.snapshot(), later);
  const noOp = await h.service.publication(
    categoryId,
    { id: randomUUID(), expectedRevision: 2, published: false },
    owner,
  );
  assert.equal(noOp.publicationRevision, 2);
  assert.equal(h.snapshot().audit.length, later.audit.length);
  assert.equal(h.snapshot().outbox.length, later.outbox.length);
  assert.equal(h.snapshot().commands.length, later.commands.length + 1);
});

test('legacy draw mutation receipts remain actor-bound, require live Session and cannot reuse another command namespace', async () => {
  const h = previewHarness(),
    previewDto = { id: randomUUID(), expectedVersion: 0 },
    preview = await h.service.preview(categoryId, previewDto, owner),
    confirmDto = { id: randomUUID(), version: preview.version };
  await h.service.confirm(categoryId, confirmDto, owner);
  const publicationDto = { id: randomUUID(), expectedRevision: 0, published: true };
  await h.service.publication(categoryId, publicationDto, owner);
  for (const [method, dto] of [
    ['preview', previewDto],
    ['confirm', confirmDto],
    ['publication', publicationDto],
  ]) {
    const before = h.snapshot();
    await assert.rejects(
      h.service[method](categoryId, dto, other),
      errorIs(409, 'COMMAND_ID_REUSED'),
    );
    assert.deepEqual(h.snapshot(), before);
  }
  const collision = randomUUID();
  h.mutate((data) => data.collisions.push(collision));
  const before = h.snapshot();
  await assert.rejects(
    h.service.publication(
      categoryId,
      { id: collision, expectedRevision: 1, published: false },
      owner,
    ),
    errorIs(409, 'COMMAND_ID_REUSED'),
  );
  assert.deepEqual(h.snapshot(), before);
  h.mutate(
    (data) =>
      (data.sessions.find((session) => session.id === owner.sessionId).expiresAt = new Date(0)),
  );
  const expired = h.snapshot();
  for (const [method, dto] of [
    ['preview', previewDto],
    ['confirm', confirmDto],
    ['publication', publicationDto],
  ]) {
    await assert.rejects(h.service[method](categoryId, dto, owner), errorIs(401, 'AUTH_REQUIRED'));
    assert.deepEqual(h.snapshot(), expired);
  }
});

test('three-way manual review creates no champion and full additional circle has one immutable command receipt', async () => {
  const h = harness(),
    dto = await h.command(),
    before = h.snapshot();
  const initial = await h.service.get(categoryId, owner);
  assert.equal(initial.progress.phase, 'ADMIN_REVIEW');
  assert.equal(initial.progress.places, null);
  const [first, retry] = await Promise.all([
    h.service.tiebreak(categoryId, dto, owner),
    h.service.tiebreak(categoryId, dto, owner),
  ]);
  assert.deepEqual(retry, first);
  assert.equal(first.version, 2);
  assert.equal(first.addedContestIds.length, 3);
  const after = h.snapshot();
  assert.equal(after.commands.length, 1);
  assert.equal(after.outbox.length, 1);
  assert.deepEqual(
    after.rows.filter((row) => before.rows.some((old) => old.id === row.id)),
    before.rows,
  );
  assert.deepEqual(
    after.rows.filter((row) => first.addedContestIds.includes(row.id)).map((row) => row.round),
    [4, 5, 6],
  );
  assert.equal(await tournamentComplete(h.tx(), tournamentId), false);
  h.mutate((state) => {
    state.record.version += 3;
  });
  const later = h.snapshot();
  assert.deepEqual(await h.service.tiebreak(categoryId, dto, owner), first);
  assert.deepEqual(h.snapshot(), later);
  await assert.rejects(
    h.service.tiebreak(categoryId, { ...dto, reason: 'Changed intent' }, owner),
    errorIs(409, 'COMMAND_ID_REUSED'),
  );
});

test('manual places bind exact order, finish RR without bouts and replay one immutable audited receipt', async () => {
  const h = harness();
  const review = (await h.service.tiebreakImpact(categoryId, owner)).reviews[0];
  const approval = {
    parent: review.parent,
    pool: review.pool,
    members: [...review.members].reverse(),
    procedure: 'ORDERED_PLACES',
  };
  const preview = await h.service.tiebreakImpact(categoryId, owner, approval);
  const dto = {
    ...approval,
    id: randomUUID(),
    expectedVersion: preview.expectedVersion,
    impactToken: preview.reviews[0].impactToken,
    reason: 'Места по оценкам и шидо',
  };
  const before = h.snapshot();
  await assert.rejects(
    h.service.tiebreak(categoryId, { ...dto, members: [...dto.members].reverse() }, owner),
    errorIs(409, 'IMPACT_CHANGED'),
  );
  assert.deepEqual(h.snapshot(), before);
  const [result, retry] = await Promise.all([
    h.service.tiebreak(categoryId, dto, owner),
    h.service.tiebreak(categoryId, dto, owner),
  ]);
  assert.deepEqual(retry, result);
  assert.equal(result.addedContestIds.length, 0);
  assert.equal(result.progress.complete, true);
  assert.deepEqual(
    result.progress.places.map((p) => p.entryId),
    approval.members,
  );
  const after = h.snapshot();
  assert.equal(after.tournament.status, 'FINISHED');
  assert.deepEqual(after.rows, before.rows);
  assert.equal(after.commands.length, 1);
  assert.equal(after.outbox.length, 1);
  assert.equal(after.audit.filter((a) => a.action === 'TOURNAMENT_FINISHED').length, 1);
  assert.deepEqual(await h.service.tiebreak(categoryId, dto, owner), result);
  assert.deepEqual(h.snapshot(), after);
});

test('withdrawal is audited, versioned and replayable without deleting entry or result history', async () => {
  const h = harness(v4(createRoundRobin(entries(3), 12)), {});
  const entryId = h.snapshot().roster[0].id;
  const preview = await h.service.withdrawalImpact(categoryId, entryId, owner);
  const dto = {
    id: randomUUID(),
    entryId,
    expectedVersion: preview.expectedVersion,
    impactToken: preview.impactToken,
    reason: 'Удалить из дальнейших встреч',
  };
  const before = h.snapshot();
  const first = await h.service.withdraw(categoryId, dto, owner);
  const after = h.snapshot();
  assert.deepEqual(after.roster, before.roster);
  assert.deepEqual(after.record.snapshot.withdrawnEntryIds, [entryId]);
  assert.equal(after.rows.filter((r) => r.resultReason === 'WALKOVER').length, 2);
  assert.equal(after.events.length, 2);
  assert.equal(after.audit.filter((a) => a.action === 'ENTRY_WITHDRAWN').length, 1);
  assert.equal(after.outbox.length, 1);
  assert.ok(after.rows.filter((r) => r.state).every((r) => r.state.awards.length === 0));
  assert.deepEqual(await h.service.withdraw(categoryId, dto, owner), first);
  assert.deepEqual(h.snapshot(), after);
  await assert.rejects(
    h.service.withdraw(categoryId, { ...dto, reason: 'Changed intent' }, owner),
    errorIs(409, 'COMMAND_ID_REUSED'),
  );
  const nextId = after.roster.find((e) => e.id !== entryId).id;
  const nextPreview = await h.service.withdrawalImpact(categoryId, nextId, owner);
  await h.service.withdraw(
    categoryId,
    {
      ...dto,
      id: randomUUID(),
      entryId: nextId,
      expectedVersion: nextPreview.expectedVersion,
      impactToken: nextPreview.impactToken,
    },
    owner,
  );
  assert.equal(h.snapshot().tournament.status, 'FINISHED');
  assert.deepEqual(
    h
      .snapshot()
      .rows.filter((r) => after.rows.some((old) => old.id === r.id && old.status === 'CONFIRMED')),
    after.rows.filter((r) => r.status === 'CONFIRMED'),
  );
});

test('withdrawal preview cannot bypass changed sporting state or offline ownership', async () => {
  const h = harness(v4(createRoundRobin(entries(3), 12)), {}),
    entryId = h.snapshot().roster[0].id;
  const preview = await h.service.withdrawalImpact(categoryId, entryId, owner);
  h.mutate((s) => {
    s.rows[0].clockAnchorMs = 123;
  });
  const before = h.snapshot();
  const dto = {
    id: randomUUID(),
    entryId,
    expectedVersion: preview.expectedVersion,
    impactToken: preview.impactToken,
    reason: 'Test withdrawal',
  };
  await assert.rejects(h.service.withdraw(categoryId, dto, owner), errorIs(409, 'IMPACT_CHANGED'));
  assert.deepEqual(h.snapshot(), before);
  h.mutate((s) => {
    s.rows[0].offlineActorId = owner.id;
  });
  const offline = await h.service.withdrawalImpact(categoryId, entryId, owner);
  assert.equal(offline.blocked, true);
  await assert.rejects(
    h.service.withdraw(categoryId, { ...dto, impactToken: offline.impactToken }, owner),
    errorIs(409, 'WITHDRAWAL_MATCH_REQUIRES_REVIEW'),
  );
});

test('withdrawal never commits automatic outcomes or receipts if audit storage fails', async () => {
  const h = harness(v4(createRoundRobin(entries(3), 12)), {}),
    entryId = h.snapshot().roster[0].id;
  const preview = await h.service.withdrawalImpact(categoryId, entryId, owner);
  h.mutate((s) => {
    s.syntheticAuditFailure = true;
  });
  const before = h.snapshot();
  await assert.rejects(
    h.service.withdraw(
      categoryId,
      {
        id: randomUUID(),
        entryId,
        expectedVersion: preview.expectedVersion,
        impactToken: preview.impactToken,
        reason: 'Test transaction rollback',
      },
      owner,
    ),
    /synthetic audit failure/,
  );
  assert.deepEqual(h.snapshot(), before);
  assert.equal(h.notices.length, 0);
});

test('manual impact is actor-bound and binds saved sporting state even without a revision change', async () => {
  const h = harness(),
    dto = await h.command(),
    before = h.snapshot();
  await assert.rejects(h.service.tiebreak(categoryId, dto, other), errorIs(409, 'IMPACT_CHANGED'));
  assert.deepEqual(h.snapshot(), before);
  h.mutate((state) => {
    state.rows[0].clockAnchorMs = 99;
  });
  const changed = h.snapshot();
  await assert.rejects(h.service.tiebreak(categoryId, dto, owner), errorIs(409, 'IMPACT_CHANGED'));
  assert.deepEqual(h.snapshot(), changed);
});

test('new manual command cannot bypass Session expiry or a global protocol UUID collision', async () => {
  const h = harness(),
    dto = await h.command();
  h.mutate((state) => state.collisions.push(dto.id));
  const before = h.snapshot();
  await assert.rejects(
    h.service.tiebreak(categoryId, dto, owner),
    errorIs(409, 'COMMAND_ID_REUSED'),
  );
  assert.deepEqual(h.snapshot(), before);
  h.mutate((state) => {
    state.collisions = [];
    state.sessions.find((session) => session.id === owner.sessionId).expiresAt = new Date(0);
  });
  const expired = h.snapshot();
  await assert.rejects(h.service.tiebreak(categoryId, dto, owner), errorIs(401, 'AUTH_REQUIRED'));
  assert.deepEqual(h.snapshot(), expired);
  assert.match(h.locks[0], /Tournament/);
  assert.match(h.locks[1], /Tatami/);
  assert.match(h.locks[2], /Session/);
  assert.match(h.locks[3], /Category/);
  assert.match(h.locks[4], /Contest/);
});

test('an exact historical manual receipt still needs a live session', async () => {
  const h = harness(),
    dto = await h.command();
  await h.service.tiebreak(categoryId, dto, owner);
  h.mutate((state) => {
    state.sessions = state.sessions.filter((session) => session.id !== owner.sessionId);
  });
  const before = h.snapshot();
  await assert.rejects(h.service.tiebreak(categoryId, dto, owner), errorIs(401, 'AUTH_REQUIRED'));
  assert.deepEqual(h.snapshot(), before);
});

function mixedHarness() {
  const draw = v4(generateDraw('MIXED', entries(12), 14, 'REPECHAGE_ONLY'));
  const results = Object.fromEntries(
    draw.pools.flatMap((pool, index) =>
      Object.entries(
        index === 0
          ? cycle(
              draw.matches.filter((match) => match.pool === pool.id),
              pool.entries,
            )
          : minimum(draw.matches.filter((match) => match.pool === pool.id)),
      ),
    ),
  );
  return harness(draw, results);
}

test('MIXED approval mirrors every shifted KO/medal round and Contest revision before releasing any qualifier', async () => {
  const h = mixedHarness(),
    before = h.snapshot(),
    dto = await h.command();
  const impact = await h.service.tiebreakImpact(categoryId, owner);
  const changed = impact.reviews[0].changedRounds;
  assert.equal(
    changed.length,
    before.record.snapshot.matches.filter((match) => !match.pool).length,
  );
  const response = await h.service.tiebreak(categoryId, dto, owner),
    after = h.snapshot();
  assert.equal(response.progress.poolStageComplete, false);
  assert.equal(response.version, 2);
  for (const change of changed) {
    const row = after.rows.find((row) => row.id === change.id);
    assert.equal(row.round, change.afterRound);
    assert.equal(row.revision, 1);
    assert.equal(row.status, 'WAITING');
    assert.equal(row.whiteEntryId, null);
    assert.equal(row.blueEntryId, null);
  }
});

test('MIXED refuses changed KO rounds with started state or partial offline generation zero', async () => {
  for (const updates of [
    { state: { status: 'PAUSED' }, status: 'ACTIVE' },
    { offlineControlGeneration: 0 },
  ]) {
    const h = mixedHarness();
    h.mutate((data) =>
      Object.assign(
        data.rows.find(
          (row) => !data.record.snapshot.matches.find((match) => match.id === row.key).pool,
        ),
        updates,
      ),
    );
    const dto = await h.command(),
      before = h.snapshot();
    assert.equal((await h.service.tiebreakImpact(categoryId, owner)).reviews[0].blocked, true);
    await assert.rejects(
      h.service.tiebreak(categoryId, dto, owner),
      errorIs(409, 'TIEBREAK_DEPENDENCY_STARTED'),
    );
    assert.deepEqual(h.snapshot(), before);
  }
});

test('two equal-winning pairs automatically create true fourth-circle bouts and never finish before the new results', async () => {
  const draw = v4(createRoundRobin(entries(4), 42)),
    [a, b, c, d] = draw.positions.map((entry) => entry.id);
  const table = new Map([
    [[a, b].sort().join('|'), a],
    [[a, c].sort().join('|'), a],
    [[a, d].sort().join('|'), d],
    [[b, c].sort().join('|'), b],
    [[b, d].sort().join('|'), b],
    [[c, d].sort().join('|'), c],
  ]);
  const h = harness(
      draw,
      Object.fromEntries(
        draw.matches.map((match) => [match.id, table.get(direct(match).sort().join('|'))]),
      ),
    ),
    before = h.snapshot();
  const response = await propagateDraw(h.tx(), before.record, matId, owner.id, tournamentId);
  assert.equal(response.addedContestIds.length, 2);
  assert.equal(response.draw.version, 2);
  assert.deepEqual(
    h
      .snapshot()
      .rows.filter((row) => response.addedContestIds.includes(row.id))
      .map((row) => [row.round, row.status, row.tatamiId]),
    [
      [4, 'READY', matId],
      [4, 'READY', matId],
    ],
  );
  assert.equal(response.progress.complete, false);
  assert.equal(await tournamentComplete(h.tx(), tournamentId), false);
});

test('a manual virtual circle blocks later tatami rounds even with every existing row confirmed', async () => {
  const h = harness();
  assert.equal(await unfinishedRound(h.tx(), matId), 4);
  h.mutate((data) => {
    data.rows[0].status = 'WAITING';
  });
  assert.equal(await unfinishedRound(h.tx(), matId), 1);
});

test('a moved confirmed individual bout does not carry its category review barrier to the target mat', async () => {
  const h = harness(),
    targetMat = randomUUID(),
    data = h.snapshot();
  data.rows[0].tatamiId = targetMat;
  const db = {
    contest: { aggregate: async () => ({ _min: { round: 5 } }) },
    category: {
      findMany: async ({ where }) => {
        // The category stays at its home despite a historical bout on targetMat.
        assert.deepEqual(where, { homeTatamiId: targetMat });
        return data.category.homeTatamiId === where.homeTatamiId
          ? [{ ...data.category, draw: { ...data.record, contests: data.rows } }]
          : [];
      },
    },
  };
  assert.equal(
    await unfinishedRound(db, targetMat),
    5,
    'the target mat can proceed with its own fifth circle; review belongs to the home mat',
  );
  assert.equal(
    await unfinishedRound(h.tx(), matId),
    4,
    'the home mat still waits for the explicitly approved tie-break circle',
  );
});

test('readyQueue independently rejects artificially READY knockout pairs while another v4 group is unresolved', async () => {
  const h = mixedHarness();
  h.mutate((data) => {
    const row = data.rows.find(
      (row) => !data.record.snapshot.matches.find((match) => match.id === row.key).pool,
    );
    Object.assign(row, {
      status: 'READY',
      tatamiId: matId,
      whiteEntryId: data.record.snapshot.pools[1].entries[0],
      blueEntryId: data.record.snapshot.pools[2].entries[0],
    });
  });
  assert.deepEqual(await readyQueue(h.tx(), matId), []);
});

test('128-athlete round-robin queue fetches one snapshot/result set for all 8128 ready pairs and preserves exact sporting eligibility', async () => {
  const draw = v4(createRoundRobin(entries(128), 128)),
    h = harness(draw, {}),
    rows = await readyQueue(h.tx(), matId);
  assert.equal(rows.length, 8128);
  assert.equal(new Set(rows.map((row) => row.key)).size, 8128);
  const snapshots = h.queries.filter((query) => query.delegate === 'drawRecord.findMany');
  assert.equal(snapshots.length, 1);
  assert.deepEqual(snapshots[0].args.where, {
    id: { in: [h.snapshot().record.id] },
    status: 'CONFIRMED',
  });
  assert.deepEqual(snapshots[0].args.select, {
    id: true,
    snapshot: true,
    contests: { select: { key: true, status: true, winnerEntryId: true, resultReason: true } },
  });
  const readyQuery = h.queries.find((query) => query.delegate === 'contest.findMany').args;
  assert.equal(readyQuery.include.draw.select.snapshot, undefined);
  assert.equal(readyQuery.include.draw.select.contests, undefined);
  assert.deepEqual(Object.keys(readyQuery.include.draw.select).sort(), ['category', 'categoryId']);
  assert.equal(rows[0].round, 1);
  assert.equal(rows.filter((row) => row.round === 1).length, 64);
  assert.equal(rows.at(-1).round, 127);
  h.mutate((data) => {
    data.rows[0].blueEntryId = data.rows[0].whiteEntryId;
  });
  assert.equal(
    (await readyQueue(h.tx(), matId)).length,
    8127,
    'saved-pair corruption cannot make an ineligible contest startable',
  );
});

test('completion guard requires RUNNING, matching active roster, known confirmed keys and fully resolved standings', async () => {
  const draw = v4(createRoundRobin(entries(3), 1)),
    h = harness(draw, minimum(draw.matches));
  assert.equal(await tournamentComplete(h.tx(), tournamentId), true);
  h.mutate((state) => {
    state.tournament.status = 'FINISHED';
  });
  assert.equal(await tournamentComplete(h.tx(), tournamentId), false);
  h.mutate((state) => {
    state.tournament.status = 'RUNNING';
    state.rows[0].winnerEntryId = null;
  });
  assert.equal(await tournamentComplete(h.tx(), tournamentId), false);
});
