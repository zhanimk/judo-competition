import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { PrismaClient } from '@prisma/client';
import WebSocket from 'ws';
import { tally, scoreboardScores } from '@judo/engine/match';
import { miniCategories, miniName, miniFirstNames } from '../fixtures/mini-tournament.mjs';

const mode = process.argv[2];
assert.ok(['prepare', 'run'].includes(mode), 'Use prepare or run');
const db = new PrismaClient();
const base = process.env.TEST_API_URL ?? 'http://127.0.0.1:4319/api/v1';
const reportPath = 'docs/reports/mini-tournament.json';
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
let session, socket, report;
const notices = [];
const protectedId = '02eb3491-602e-4a38-aede-9f9a95f273cf';
async function protectedSnapshot() {
  return db.tournament.findUniqueOrThrow({
    where: { id: protectedId },
    include: {
      categories: {
        orderBy: { id: 'asc' },
        include: { entries: { orderBy: { id: 'asc' } }, draw: true },
      },
      tatamis: { orderBy: { id: 'asc' } },
    },
  });
}
async function save() {
  await mkdir('docs/reports', { recursive: true });
  await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n');
}
try {
  const before = await protectedSnapshot();
  const owner = await db.user.findFirstOrThrow({
    where: { role: 'SUPER_ADMIN', email: 'admin@judo.local' },
  });
  const token = randomBytes(32).toString('hex');
  session = await db.session.create({
    data: {
      userId: owner.id,
      tokenHash: createHash('sha256').update(token).digest('hex'),
      expiresAt: new Date(Date.now() + 3600000),
    },
  });
  const cookie = `judo_session=${token}`;
  async function call(path, data, auth = cookie) {
    const r = await fetch(base + path, {
      method: data === undefined ? 'GET' : 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Judo-Client': 'web', Cookie: auth },
      body: data === undefined ? undefined : JSON.stringify(data),
    });
    return { status: r.status, body: await r.json() };
  }
  async function get(path, auth = cookie) {
    const r = await call(path, undefined, auth);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    return r.body;
  }
  async function post(path, data = {}) {
    const r = await call(path, data);
    assert.equal(r.status, 201, JSON.stringify(r.body));
    return r.body;
  }
  if (mode === 'prepare') {
    assert.equal(
      await db.tournament.count({ where: { name: miniName } }),
      0,
      'Mini tournament already exists; do not duplicate',
    );
    const t = await post('/tournaments', {
      name: miniName,
      city: 'Астана',
      venue: 'Сынақ алаңы · Тестовая арена',
      startDate: '2026-10-08',
      endDate: '2026-10-08',
      tatamiCount: 3,
    });
    report = {
      tournamentId: t.id,
      name: miniName,
      status: 'PREPARING',
      categories: [],
      checks: [],
      synthetic: true,
      provisionalRules: true,
      restAcceleration:
        'Only this test tournament: confirmed bouts are aged by 10 minutes to avoid waiting during rehearsal.',
      url: `http://127.0.0.1:4318/public/tournaments/${t.id}`,
      controlUrl: `http://127.0.0.1:4318/tournaments/${t.id}/control`,
    };
    await save();
    let athlete = 0;
    for (const spec of miniCategories) {
      const c = await post(`/tournaments/${t.id}/categories`, {
        name: spec.name,
        format: spec.format,
        gender: 'MALE',
        birthYearFrom: spec.from,
        birthYearTo: spec.to,
        maxWeightGrams: spec.weight * 1000,
        durationSeconds: spec.from === 2012 ? 180 : 120,
      });
      for (let i = 0; i < spec.count; i++) {
        athlete++;
        await post(`/tournaments/${t.id}/categories/${c.id}/entries`, {
          firstName: miniFirstNames[i % miniFirstNames.length],
          lastName: `СЫНАҚ-${String(athlete).padStart(3, '0')}`,
          club: `Сынақ клубы ${(i % 4) + 1}`,
          birthYear: spec.from + (i % (spec.to - spec.from + 1)),
        });
      }
      const preview = await post(`/categories/${c.id}/draw/preview`);
      const d = await post(`/categories/${c.id}/draw/confirm`, { version: preview.version });
      if (spec.format === 'SINGLE_ELIMINATION' || spec.format === 'REPECHAGE')
        assert.equal(d.snapshot.firstRoundClubPairs, 0, 'Avoidable club pairing');
      if (spec.count === 7) assert.equal(d.snapshot.positions.filter((p) => p === null).length, 1);
      if (spec.format === 'ROUND_ROBIN') {
        assert.equal(d.contests.length, 10);
        assert.equal(
          new Set(d.contests.map((m) => [m.whiteEntryId, m.blueEntryId].sort().join(':'))).size,
          10,
        );
      }
      await post(`/categories/${c.id}/draw/publication`, { published: true, expectedRevision: 0 });
      report.categories.push({
        id: c.id,
        ...spec,
        drawId: d.id,
        bouts: d.contests.length,
        firstRoundClubPairs: d.snapshot.firstRoundClubPairs,
      });
      await save();
    }
    await post(`/tournaments/${t.id}/publish`);
    await post(`/tournaments/${t.id}/start`);
    await post(`/tournaments/${t.id}/start`);
    assert.equal(
      await db.auditEvent.count({ where: { tournamentId: t.id, action: 'TOURNAMENT_STARTED' } }),
      1,
    );
    report.tatamis = await db.tatami.findMany({
      where: { tournamentId: t.id },
      select: { id: true, number: true },
      orderBy: { number: 'asc' },
    });
    const cats = await db.category.findMany({
      where: { tournamentId: t.id },
      include: { draw: { include: { contests: true } } },
    });
    report.loads = report.tatamis.map((m) => ({
      number: m.number,
      bouts: cats
        .filter((c) => c.homeTatamiId === m.id)
        .reduce((n, c) => n + c.draw.contests.length, 0),
    }));
    report.checks.push(
      '34 athletes, 5 categories, all 4 supported formats plus 2-person final',
      'Knockout club separation, BYE and round-robin pair uniqueness',
      'Start idempotency, automatic category assignment',
    );
    report.status = 'READY_TO_WATCH';
    await save();
    console.log(JSON.stringify(report, null, 2));
  } else {
    report = JSON.parse(await readFile(reportPath, 'utf8'));
    assert.ok(
      report.status === 'READY_TO_WATCH' || (report.status === 'FAILED' && !report.completed),
      'Resume only before the first completed bout',
    );
    const id = report.tournamentId;
    assert.notEqual(id, protectedId);
    assert.equal((await db.tournament.findUniqueOrThrow({ where: { id } })).name, miniName);
    if (report.error) {
      report.harnessCorrections = [...(report.harnessCorrections ?? []), report.error];
      delete report.error;
    }
    report.status = 'RUNNING_TESTS';
    report.startedAt = new Date().toISOString();
    await save();
    const scope = { draw: { category: { tournamentId: id } } };
    const pinned = await db.category.findMany({
      where: { tournamentId: id },
      select: { id: true, homeTatamiId: true },
      orderBy: { id: 'asc' },
    });
    const wsUrl = new URL(`${base}/live`);
    wsUrl.protocol = 'ws:';
    wsUrl.searchParams.set('tournamentId', id);
    socket = new WebSocket(wsUrl, { origin: 'http://127.0.0.1:4318' });
    socket.on('message', (raw) => notices.push(JSON.parse(raw.toString())));
    await new Promise((resolve, reject) => {
      socket.once('open', resolve);
      socket.once('error', reject);
    });
    async function row(boutId) {
      return db.contest.findUniqueOrThrow({ where: { id: boutId } });
    }
    async function cmd(boutId, type, extra = {}) {
      const b = await row(boutId);
      return post(`/tatamis/${b.tatamiId}/live/${b.id}/command`, {
        id: randomUUID(),
        type,
        expectedVersion: b.revision,
        ...extra,
      });
    }
    async function admin(boutId, type, extra = {}) {
      const impact = await get(`/tournaments/${id}/control/${boutId}/impact`);
      return post(`/tournaments/${id}/control/${boutId}/command`, {
        id: randomUUID(),
        type,
        expectedRevision: impact.revision,
        impactToken: impact.impactToken,
        reason: 'Наблюдаемая репетиция / Көрнекі сынақ',
        ...extra,
      });
    }
    async function checkpoint(message) {
      report.checks.push(message);
      await save();
      console.log(`PASS ${message}`);
    }
    if (!report.completed) {
      const interrupted = await db.contest.findMany({ where: { ...scope, status: 'ACTIVE' } });
      for (const bout of interrupted) {
        if (bout.state?.status === 'RUNNING') await cmd(bout.id, 'STOP');
        await admin(bout.id, 'RESET');
      }
    }
    // Give viewers a visible countdown without changing production timing.
    console.log('Starting visible bouts in 15 seconds');
    await delay(15000);
    let completed = 0;
    while (true) {
      const queues = await Promise.all(
        report.tatamis.map(async (m) => (await get(`/tournaments/${id}/tatamis/${m.id}`)).queue),
      );
      const available = queues.map((q) => q.find((c) => !c.blockedByRound)).filter(Boolean);
      if (!available.length) break;
      const next = available[completed % available.length];
      let b = await row(next.id);
      const boutId = b.id,
        matId = b.tatamiId;
      // Acceleration applies only to confirmed records in this named synthetic tournament.
      await db.contest.updateMany({
        where: { ...scope, status: 'CONFIRMED' },
        data: { confirmedAt: new Date(Date.now() - 601000) },
      });
      if (completed === 0) {
        assert.equal(
          (
            await call(
              `/tatamis/${matId}/live/${boutId}/command`,
              { id: randomUUID(), type: 'START', expectedVersion: b.revision },
              '',
            )
          ).status,
          401,
        );
      }
      b = await cmd(boutId, 'START');
      console.log(`LIVE ${completed + 1}: ${next.id}`);
      if (completed === 0) {
        const award = {
          id: randomUUID(),
          type: 'AWARD',
          side: 'WHITE',
          kind: 'YUKO',
          expectedVersion: b.revision,
        };
        const path = `/tatamis/${matId}/live/${boutId}/command`;
        await post(path, award);
        await post(path, award);
        assert.equal(await db.matchEvent.count({ where: { id: award.id } }), 1);
        await delay(3000);
        b = await cmd(boutId, 'REVOKE', { awardId: award.id });
        assert.equal(tally(b.state, 'WHITE').YUKO, 0);
        assert.equal(b.state.status, 'PAUSED');
        await delay(2000);
        await cmd(boutId, 'START');
        await cmd(boutId, 'HOLD', { side: 'WHITE' });
        for (const kind of ['YUKO', 'WAZA_ARI', 'IPPON']) {
          const deadline = Date.now() + 14000;
          do {
            await delay(100);
            b = await row(boutId);
          } while (tally(b.state, 'WHITE')[kind] !== 1 && Date.now() < deadline);
          assert.equal(tally(b.state, 'WHITE')[kind], 1, `Automatic hold ${kind}`);
          assert.equal(
            b.state.awards.filter((a) => a.active).length,
            1,
            'One hold must not accumulate smaller scores',
          );
          console.log(`HOLD ${kind}`);
        }
        await checkpoint(
          'Real timer: hold 5s YUKO → 10s WAZA-ARI → 20s IPPON; undo and repeated command',
        );
      } else if (completed === 1) {
        for (let n = 0; n < 3; n++) {
          await delay(2000);
          b = await cmd(boutId, 'AWARD', { side: 'BLUE', kind: 'SHIDO' });
        }
        assert.equal(b.state.outcome.reason, 'ACCUMULATED_SHIDO');
        assert.equal(scoreboardScores(b.state, 'WHITE').IPPON, 1);
        const third = b.state.awards.filter((a) => a.active && a.kind === 'SHIDO').at(-1);
        await delay(2000);
        b = await cmd(boutId, 'REVOKE', { awardId: third.id });
        assert.equal(scoreboardScores(b.state, 'WHITE').IPPON, 0);
        await delay(2000);
        b = await cmd(boutId, 'AWARD', { side: 'BLUE', kind: 'SHIDO' });
        assert.equal(scoreboardScores(b.state, 'WHITE').IPPON, 1);
        await checkpoint(
          'Third SHIDO awards displayed IPPON to opponent; revoke restores match correctly',
        );
      } else if (completed === 2) {
        await cmd(boutId, 'AWARD', { side: 'WHITE', kind: 'WAZA_ARI' });
        await delay(3000);
        b = await cmd(boutId, 'AWARD', { side: 'WHITE', kind: 'WAZA_ARI' });
        assert.equal(b.state.status, 'PROVISIONAL');
        await checkpoint('Two WAZA-ARI produce provisional victory');
      } else {
        await delay(2000);
        await cmd(boutId, 'AWARD', { side: completed % 2 ? 'BLUE' : 'WHITE', kind: 'IPPON' });
      }
      await delay(2000);
      b = await row(boutId);
      const confirm = { id: randomUUID(), type: 'CONFIRM', expectedVersion: b.revision };
      const path = `/tatamis/${matId}/live/${boutId}/command`;
      await post(path, confirm);
      await post(path, confirm);
      assert.equal(await db.matchEvent.count({ where: { id: confirm.id } }), 1);
      if (completed === 2) {
        b = await row(boutId);
        const oldWinner = b.winnerEntryId;
        await admin(boutId, 'REOPEN');
        const reopened = await row(boutId);
        for (const award of reopened.state.awards.filter((a) => a.active))
          await cmd(boutId, 'REVOKE', { awardId: award.id });
        await delay(3000);
        await cmd(boutId, 'AWARD', { side: 'BLUE', kind: 'IPPON' });
        await cmd(boutId, 'CONFIRM');
        assert.notEqual((await row(boutId)).winnerEntryId, oldWinner);
        await checkpoint(
          'Admin reopens confirmed result and corrects winner before dependent bouts',
        );
      }
      completed++;
      report.completed = completed;
      await save();
      assert.ok(completed <= 60, 'Progress guard');
      const publicView = await get(`/public/tournaments/${id}`, '');
      assert.equal(
        publicView.categories
          .flatMap((c) => c.draw.contests)
          .filter((c) => c.status === 'CONFIRMED').length,
        completed,
      );
      assert.deepEqual(
        await db.category.findMany({
          where: { tournamentId: id },
          select: { id: true, homeTatamiId: true },
          orderBy: { id: 'asc' },
        }),
        pinned,
      );
    }
    const total = report.categories.reduce((n, c) => n + c.bouts, 0);
    assert.equal(completed, total);
    assert.equal((await db.tournament.findUniqueOrThrow({ where: { id } })).status, 'FINISHED');
    assert.equal(await db.contest.count({ where: { ...scope, status: { not: 'CONFIRMED' } } }), 0);
    assert.ok(notices.some((n) => n.kind === 'state'));
    assert.ok(notices.some((n) => n.kind === 'result'));
    await checkpoint(
      'All bouts finished; public results match database; category tatamis retained; WebSocket state/result received',
    );
    report.pdfs = [];
    await mkdir('output/mini-cup', { recursive: true });
    for (const lang of ['kk', 'ru'])
      for (const kind of ['DRAW', 'PARTICIPANTS']) {
        const response = await fetch(
          `${base}/tournaments/${id}/protocol.pdf?lang=${lang}&kind=${kind}`,
          { headers: { Cookie: cookie } },
        );
        assert.equal(response.status, 200);
        const bytes = Buffer.from(await response.arrayBuffer());
        assert.equal(bytes.subarray(0, 4).toString(), '%PDF');
        const file = `output/mini-cup/${kind.toLowerCase()}-${lang}.pdf`;
        await writeFile(file, bytes);
        report.pdfs.push(file);
      }
    await checkpoint('Completed draws and participant PDFs downloaded in KK/RU');
    report.status = 'PASSED';
    report.finishedAt = new Date().toISOString();
    report.websocketEvents = notices.length;
    await save();
    console.log(JSON.stringify({ status: report.status, completed, url: report.url }, null, 2));
  }
  assert.deepEqual(await protectedSnapshot(), before, 'EVEREST must remain unchanged');
} catch (error) {
  if (report) {
    report.status = 'FAILED';
    report.error = error.message;
    await save();
  }
  console.error(error);
  process.exitCode = 1;
} finally {
  socket?.close();
  if (session) await db.session.deleteMany({ where: { id: session.id } });
  await db.$disconnect();
}
