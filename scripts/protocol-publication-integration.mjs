import assert from 'node:assert/strict';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { PrismaClient } from '@prisma/client';
import { generateDraw, resolveMatches } from '@judo/engine/draw';
import { createMatch } from '@judo/engine/match';
import { createTestUser, createTestEntries } from './test-user.mjs';
import { fixtureRequest } from './test-access.mjs';
import { pdfText } from './pdf-text.mjs';

const connection = new URL(process.env.DATABASE_URL);
assert.match(connection.searchParams.get('schema') ?? '', /^qa_rehearsal_[a-f0-9]{32}$/);
const base = process.env.TEST_API_URL;
assert.ok(base, 'Publication tests require the disposable rehearsal API');
const db = new PrismaClient(),
  users = [],
  proof = [];
let tournament,
  cookie = '',
  mat;
const root = () => `/tournaments/${tournament}/protocols`;
const guest = () => `/public/tournaments/${tournament}/protocols`;
async function call(path, body, auth = cookie) {
  const response = await fixtureRequest(base, path, body, auth);
  return {
    status: response.status,
    body: await response.json(),
    cookie: response.headers.get('set-cookie')?.split(';')[0],
  };
}
async function ok(path, body, auth = cookie) {
  const r = await call(path, body, auth);
  assert.equal(r.status, body === undefined ? 200 : 201, JSON.stringify(r.body));
  return r.body;
}
async function reject(path, body, status, code, auth = cookie) {
  const r = await call(path, body, auth);
  assert.equal(r.status, status, JSON.stringify(r.body));
  if (code) assert.equal(r.body.message, code);
  return r;
}
async function login() {
  const user = await createTestUser(db);
  users.push(user.id);
  const r = await call('/auth/login', { email: user.email, password: user.password }, '');
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return { user, cookie: r.cookie };
}
async function command(kind = 'DRAW', lang = 'ru', categoryIds) {
  const history = await ok(root());
  return {
    id: randomUUID(),
    expectedRevision: history.revision,
    reason: 'QA: проверенная версия протокола',
    kind,
    lang,
    ...(categoryIds ? { categoryIds } : {}),
  };
}
async function visibility(artifact, type = 'PUBLISH') {
  const history = await ok(root());
  return {
    id: randomUUID(),
    expectedRevision: history.revision,
    reason: 'QA: проверка опубликованного снимка',
    type,
    sha256: artifact.sha256,
  };
}
async function bytes(artifact, auth = cookie, publicRoute = false, status = 200) {
  const r = await fixtureRequest(
    base,
    `${publicRoute ? guest() : root()}/${artifact.id}.pdf`,
    undefined,
    auth,
  );
  assert.equal(r.status, status);
  assert.match(r.headers.get('cache-control') ?? '', /no-store/);
  if (status !== 200) return null;
  assert.match(r.headers.get('content-type') ?? '', /^application\/pdf/);
  const content = Buffer.from(await r.arrayBuffer());
  assert.equal(content.length, artifact.byteSize);
  assert.equal(createHash('sha256').update(content).digest('hex'), artifact.sha256);
  return content;
}
async function seedCategory(owner, complete) {
  const category = await db.category.create({
    data: {
      tournamentId: tournament,
      name: complete ? 'U15 −50 · аяқталды' : 'U13 −40 · дайындық',
      gender: 'MALE',
      birthYearFrom: complete ? 2012 : 2014,
      birthYearTo: complete ? 2013 : 2015,
      maxWeightGrams: complete ? 50000 : 40000,
      durationSeconds: 180,
      format: 'ROUND_ROBIN',
    },
  });
  const entries = [0, 1].map((i) => ({
    id: randomUUID(),
    categoryId: category.id,
    firstName: i ? 'Әлия' : 'Али',
    lastName: `ПубликацияДо${complete ? 'Готово' : 'Ожидает'}${i}`,
    birthYear: category.birthYearFrom,
    club: `Клуб ${i}`,
  }));
  await createTestEntries(db, entries);
  const snapshot = generateDraw(
    'ROUND_ROBIN',
    entries.map(({ id, club }) => ({ id, clubId: club })),
    42,
  );
  const draw = await db.drawRecord.create({
    data: {
      categoryId: category.id,
      status: 'CONFIRMED',
      fingerprint: randomUUID(),
      snapshot,
      confirmedAt: new Date(),
      publishedAt: complete ? new Date() : null,
    },
  });
  const resolved = resolveMatches(
      snapshot,
      complete ? { [snapshot.matches[0].id]: entries[0].id } : {},
    ),
    row = resolved[0];
  const state = createMatch({
    durationMs: 180000,
    shidoLimit: 3,
    wazaForIppon: 2,
    enabledScores: ['YUKO', 'WAZA_ARI', 'IPPON'],
    holdThresholds: [{ ms: 20000, score: 'IPPON' }],
  });
  if (complete) {
    state.status = 'CONFIRMED';
    state.awards = [
      {
        id: randomUUID(),
        side: row.whiteEntryId === entries[0].id ? 'WHITE' : 'BLUE',
        kind: 'IPPON',
        active: true,
      },
    ];
    state.outcome = {
      winner: row.whiteEntryId === entries[0].id ? 'WHITE' : 'BLUE',
      reason: 'IPPON',
    };
  }
  const contest = await db.contest.create({
    data: {
      drawId: draw.id,
      key: row.id,
      round: row.round,
      status: complete ? 'CONFIRMED' : 'WAITING',
      whiteEntryId: row.whiteEntryId,
      blueEntryId: row.blueEntryId,
      winnerEntryId: complete ? entries[0].id : null,
      resultReason: complete ? 'IPPON' : null,
      confirmedAt: complete ? new Date() : null,
      state,
    },
  });
  return { category, entries, draw, contest };
}
try {
  const owner = await login(),
    foreign = await login();
  cookie = owner.cookie;
  tournament = (
    await db.tournament.create({
      data: {
        name: 'PUBLICATION QA · Қазақша PDF',
        city: 'Алматы',
        venue: 'Изолированная QA арена',
        startDate: '2026-10-10',
        endDate: '2026-10-10',
        tatamiCount: 1,
        ownerId: owner.user.id,
      },
    })
  ).id;
  mat = (await db.tatami.create({ data: { tournamentId: tournament, number: 1 } })).id;
  const ready = await seedCategory(owner, true),
    waiting = await seedCategory(owner, false),
    scope = [ready.category.id];
  const token = randomBytes(32).toString('hex');
  await ok(`/auth/tatamis/${mat}/invitations`, { label: 'Publication judge QA', hours: 1, token });
  const accepted = await call('/auth/invitations/accept', { token, name: 'QA судья' }, '');
  assert.equal(accepted.status, 201);
  users.push((await ok('/auth/me', undefined, accepted.cookie)).id);
  assert.deepEqual((await ok(root())).artifacts, []);
  const create = await command('DRAW', 'ru', scope),
    first = await ok(root(), create),
    a = first.artifact;
  assert.equal(first.revision, 1);
  assert.equal(a.version, 1);
  assert.notEqual(a.id, create.id);
  assert.equal(a.publishedAt, null);
  const initial = await bytes(a);
  assert.ok(pdfText(initial).includes(ready.entries[0].lastName));
  assert.ok(!pdfText(initial).includes(waiting.entries[0].lastName));
  assert.deepEqual(
    await ok(root(), create),
    first,
    'Exact CREATE is a receipt, not a newly generated PDF',
  );
  assert.equal(await db.protocolArtifact.count({ where: { tournamentId: tournament } }), 1);
  assert.equal(await db.protocolCommand.count({ where: { tournamentId: tournament } }), 1);
  assert.equal(
    await db.auditEvent.count({ where: { tournamentId: tournament, action: 'PROTOCOL_CREATE' } }),
    1,
  );
  assert.equal(
    await db.liveOutbox.count({ where: { tournamentId: tournament, kind: 'protocol' } }),
    1,
  );
  await reject(root(), { ...create, reason: 'Different intent' }, 409, 'COMMAND_ID_REUSED');
  await reject(root(), await command(), 401, undefined, '');
  await reject(root(), await command(), 403, undefined, foreign.cookie);
  await reject(root(), await command(), 403, undefined, accepted.cookie);
  await reject(root(), await command('ALL'), 400);
  await reject(
    root(),
    { ...(await command()), categoryIds: [randomUUID()] },
    404,
    'CATEGORY_NOT_FOUND',
  );
  await reject(guest(), undefined, 404, undefined, '');
  await bytes(a, '', true, 404);
  await reject(`${root()}/${a.id}/command`, await visibility(a), 409, 'TOURNAMENT_NOT_PUBLISHED');
  await ok(`/tournaments/${tournament}/publish`, {});
  assert.deepEqual((await ok(guest(), undefined, '')).artifacts, []);
  await bytes(a, '', true, 404);
  const publish = await visibility(a),
    published = await ok(`${root()}/${a.id}/command`, publish);
  assert.ok(published.artifact.publishedAt);
  assert.deepEqual(await ok(`${root()}/${a.id}/command`, publish), published);
  assert.deepEqual(await bytes(a, '', true), initial);
  const kk = (await ok(root(), await command('DRAW', 'kk', scope))).artifact;
  await ok(`${root()}/${kk.id}/command`, await visibility(kk));
  assert.equal(
    (await ok(guest(), undefined, '')).artifacts.length,
    2,
    'Publishing a new language does not retract the previous file',
  );
  const unpublished = (await ok(root(), await command('PARTICIPANTS', 'ru', scope))).artifact;
  const nameCommand = {
    id: randomUUID(),
    expectedRevision: (await ok(`/tournaments/${tournament}/clubs`)).revision,
    firstName: 'Әлихан',
    lastName: 'ПубликацияИсправлено',
    reason: 'QA: исправление ФИО после снимка',
  };
  const renamed = await ok(
    `/tournaments/${tournament}/roster/entries/${ready.entries[0].id}/name`,
    nameCommand,
  );
  assert.equal(renamed.entry.id, ready.entries[0].id);
  const archival = await ok(guest(), undefined, '');
  assert.ok(archival.artifacts.every((row) => row.sourceCurrent === false));
  assert.deepEqual(await bytes(a, '', true), initial);
  assert.ok(!pdfText(initial).includes(nameCommand.lastName));
  await reject(
    `${root()}/${unpublished.id}/command`,
    await visibility(unpublished),
    409,
    'PROTOCOL_SOURCE_CHANGED',
  );
  await reject(root(), { ...(await command()), id: nameCommand.id }, 409, 'COMMAND_ID_REUSED');
  const fresh = (await ok(root(), await command('DRAW', 'ru', scope))).artifact,
    newBytes = await bytes(fresh);
  assert.notEqual(fresh.sha256, a.sha256);
  assert.ok(pdfText(newBytes).includes(nameCommand.lastName));
  assert.ok(!pdfText(newBytes).includes(ready.entries[0].lastName));
  await ok(`${root()}/${fresh.id}/command`, await visibility(fresh));
  const publicRows = (await ok(guest(), undefined, '')).artifacts;
  assert.equal(publicRows.length, 3);
  assert.equal(publicRows.find((row) => row.id === fresh.id).latest, true);
  assert.equal(publicRows.find((row) => row.id === a.id).latest, false);
  assert.equal(publicRows.find((row) => row.id === a.id).sourceCurrent, false);
  assert.ok(publicRows.every((row) => !('bytes' in row) && !('createdById' in row)));
  await reject(root(), await command('TEAMS'), 409, 'TEAMS_NOT_READY');
  for (const lang of ['ru', 'kk'])
    for (const kind of ['PARTICIPANTS', 'TEAMS']) {
      const file = (await ok(root(), await command(kind, lang, scope))).artifact;
      await ok(`${root()}/${file.id}/command`, await visibility(file));
      const content = await bytes(file, '', true);
      proof.push({
        kind,
        lang,
        version: file.version,
        id: file.id,
        sha256: file.sha256,
        byteSize: file.byteSize,
      });
      await mkdir('tmp/pdfs/publication', { recursive: true });
      await writeFile(`tmp/pdfs/publication/${kind.toLowerCase()}-${lang}.pdf`, content);
    }
  await mkdir('tmp/pdfs/publication', { recursive: true });
  await writeFile('tmp/pdfs/publication/draw-ru.pdf', newBytes);
  await writeFile('tmp/pdfs/publication/draw-kk.pdf', await bytes(kk, '', true));
  proof.push({
    kind: fresh.kind,
    lang: fresh.lang,
    version: fresh.version,
    id: fresh.id,
    sha256: fresh.sha256,
    byteSize: fresh.byteSize,
  });
  const sportingBefore = await db.contest.findUniqueOrThrow({ where: { id: ready.contest.id } }),
    dbArtifact = await db.protocolArtifact.findUniqueOrThrow({ where: { id: a.id } });
  const retract = await visibility(a, 'UNPUBLISH'),
    withdrawn = await ok(`${root()}/${a.id}/command`, retract);
  assert.equal(withdrawn.artifact.publishedAt, null);
  await bytes(a, '', true, 404);
  assert.deepEqual(await bytes(a), initial);
  assert.deepEqual(
    await ok(`${root()}/${a.id}/command`, publish),
    published,
    'Old PUBLISH receipt cannot re-publish a withdrawn file',
  );
  await bytes(a, '', true, 404);
  assert.deepEqual(
    await ok(root(), create),
    first,
    'Old CREATE receipt cannot create another version or roll back newer names',
  );
  assert.equal(
    (await db.entry.findUniqueOrThrow({ where: { id: ready.entries[0].id } })).lastName,
    nameCommand.lastName,
  );
  assert.deepEqual(
    await db.contest.findUniqueOrThrow({ where: { id: ready.contest.id } }),
    sportingBefore,
  );
  const retained = await db.protocolArtifact.findUniqueOrThrow({ where: { id: a.id } });
  for (const key of [
    'id',
    'version',
    'kind',
    'lang',
    'scope',
    'categoryIds',
    'source',
    'sha256',
    'byteSize',
    'bytes',
    'createdById',
    'createdAt',
  ])
    assert.deepEqual(retained[key], dbArtifact[key], `Publication modified immutable ${key}`);
  // Change only this synthetic fixture's confirmed sporting result. Publication
  // must detect the newer document input while retaining the prior exact bytes.
  const correctedState = structuredClone(sportingBefore.state);
  const otherWinner = ready.entries[1].id;
  const otherSide = sportingBefore.whiteEntryId === otherWinner ? 'WHITE' : 'BLUE';
  correctedState.outcome = { winner: otherSide, reason: 'IPPON' };
  correctedState.awards = [{ id: randomUUID(), side: otherSide, kind: 'IPPON', active: true }];
  await db.contest.update({
    where: { id: ready.contest.id },
    data: { winnerEntryId: otherWinner, state: correctedState },
  });
  assert.equal(
    (await ok(guest(), undefined, '')).artifacts.find((row) => row.id === fresh.id).sourceCurrent,
    false,
  );
  assert.deepEqual(
    await bytes(fresh, '', true),
    newBytes,
    'Later results cannot rewrite a published artifact',
  );
  for (const lang of ['ru', 'kk']) {
    const current = (await ok(root(), await command('DRAW', lang, scope))).artifact;
    await ok(`${root()}/${current.id}/command`, await visibility(current));
    const content = await bytes(current, '', true);
    assert.ok(pdfText(content).includes(nameCommand.lastName));
    if (lang === 'ru') assert.notEqual(current.sha256, fresh.sha256);
    await writeFile(`tmp/pdfs/publication/draw-${lang}.pdf`, content);
    proof.push({
      kind: 'DRAW',
      lang,
      version: current.version,
      id: current.id,
      sha256: current.sha256,
      byteSize: current.byteSize,
      filename: `draw-${lang}.pdf`,
    });
  }
  const drawPublication = await db.drawRecord.findUniqueOrThrow({ where: { id: ready.draw.id } });
  await ok(`/categories/${ready.category.id}/draw/publication`, {
    published: false,
    expectedRevision: drawPublication.publicationRevision,
  });
  assert.deepEqual(
    await bytes(fresh, '', true),
    newBytes,
    'Live draw visibility must not implicitly revoke an explicitly published snapshot',
  );
  await db.tournament.update({ where: { id: tournament }, data: { publishedAt: null } });
  await reject(guest(), undefined, 404, undefined, '');
  await bytes(fresh, '', true, 404);
  await db.tournament.update({ where: { id: tournament }, data: { publishedAt: new Date() } });
  const parallel = await command('PARTICIPANTS', 'ru', scope),
    parallel2 = { ...parallel, id: randomUUID() },
    race = await Promise.all([call(root(), parallel), call(root(), parallel2)]);
  assert.deepEqual(race.map((r) => r.status).sort(), [201, 409]);
  assert.equal(race.find((r) => r.status === 409).body.message, 'PROTOCOL_VERSION_CONFLICT');
  const history = await ok(root()),
    older = await ok(`${root()}?beforeVersion=${fresh.version}`);
  assert.ok(older.artifacts.every((row) => row.version < fresh.version));
  const audits = await db.auditEvent.findMany({
      where: { tournamentId: tournament, action: { startsWith: 'PROTOCOL_' } },
    }),
    commands = await db.protocolCommand.findMany({ where: { tournamentId: tournament } });
  assert.equal(audits.length, commands.length);
  assert.equal(
    await db.liveOutbox.count({ where: { tournamentId: tournament, kind: 'protocol' } }),
    commands.length,
  );
  assert.equal(history.revision, commands.length);
  await writeFile(
    'tmp/pdfs/publication/proof.json',
    JSON.stringify(
      {
        schema: connection.searchParams.get('schema'),
        artifacts: proof,
        commandCount: commands.length,
      },
      null,
      2,
    ),
  );
  await ok('/auth/logout', {});
  await reject(root(), create, 401);
  await reject(
    `${root()}/${fresh.id}/command`,
    {
      id: randomUUID(),
      expectedRevision: history.revision,
      type: 'UNPUBLISH',
      reason: 'QA logout',
      sha256: fresh.sha256,
    },
    401,
  );
  console.log(
    'PASS protocol publication: immutable DRAW/PARTICIPANTS/TEAMS RU/KK bytes, review/hash/source guards, name correction snapshot history, multiple published versions, guest-only downloads/revoke, exact old receipts, concurrent versions, live Session, admin/judge/owner/global-ID guards, transactional audit/outbox, PDF proof files',
  );
} finally {
  if (tournament) {
    await db.matchEvent.deleteMany({
      where: { contest: { draw: { category: { tournamentId: tournament } } } },
    });
    await db.contest.deleteMany({ where: { draw: { category: { tournamentId: tournament } } } });
    await db.drawRecord.deleteMany({ where: { category: { tournamentId: tournament } } });
    await db.entry.deleteMany({ where: { category: { tournamentId: tournament } } });
    await db.category.deleteMany({ where: { tournamentId: tournament } });
    await db.invitation.deleteMany({ where: { tatami: { tournamentId: tournament } } });
    await db.tatami.deleteMany({ where: { tournamentId: tournament } });
    await db.auditEvent.deleteMany({ where: { tournamentId: tournament } });
    await db.tournament.delete({ where: { id: tournament } });
  }
  await db.session.deleteMany({ where: { userId: { in: users } } });
  await db.athlete.deleteMany({ where: { ownerId: { in: users }, entries: { none: {} } } });
  await db.user.deleteMany({ where: { id: { in: users } } });
  await db.$disconnect();
}
