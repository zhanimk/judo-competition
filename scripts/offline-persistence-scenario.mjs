import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { randomUUID, createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { fixtureRequest, fixtureControl } from './test-access.mjs';
import { createTestUser } from './test-user.mjs';
import {
  appendJournalCommand,
  acknowledgeJournalPacket,
} from '../apps/web/src/features/offline/journal.ts';

/** Real HTTP/PostgreSQL with a private TCP fault proxy. The JSON checkpoints
 * exercise packet recovery; actual browser IndexedDB is a separate acceptance. */
export async function offlinePersistenceScenario({ db, base, output, restart }) {
  const schema = new URL(process.env.DATABASE_URL).searchParams.get('schema');
  // The runner passes its own client; check its actual schema, not the inherited env URL.
  const [{ actual }] = await db.$queryRaw`SELECT current_schema()::text AS actual`;
  assert.match(actual, /^qa_rehearsal_[a-f0-9]{32}$/);
  const owner = await createTestUser(db);
  const login = await fixtureRequest(base, '/auth/login', {
    email: owner.email,
    password: owner.password,
  });
  assert.equal(login.status, 201);
  const cookie = login.headers.get('set-cookie').split(';')[0];
  async function call(path, data, through = base) {
    const response = await fixtureRequest(through, path, data, cookie);
    const body = await response.json();
    assert.ok(response.ok, `${path}: ${JSON.stringify(body)}`);
    return body;
  }
  let blocked = false,
    fault = null,
    crashRestarts = 0;
  const proxy = createServer(async (request, response) => {
    if (blocked) {
      request.socket.destroy();
      return;
    }
    try {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const body = Buffer.concat(chunks);
      const upstream = await fetch(new URL(request.url, new URL(base).origin), {
        method: request.method,
        headers: { 'Content-Type': 'application/json', 'X-Judo-Client': 'web', Cookie: cookie },
        ...(body.length ? { body } : {}),
      });
      const bytes = Buffer.from(await upstream.arrayBuffer());
      const packet = body.length ? JSON.parse(body.toString()) : null;
      const selected = fault && packet?.id === fault.id && upstream.ok ? fault : null;
      if (selected) fault = null;
      if (selected?.mode === 'disconnect') {
        request.socket.destroy();
        return;
      }
      response.writeHead(selected ? 200 : upstream.status, { 'Content-Type': 'application/json' });
      response.end(selected?.mode === 'malformed' ? '{}' : bytes);
    } catch {
      request.socket.destroy();
    }
  });
  proxy.listen(0, '127.0.0.1');
  await once(proxy, 'listening');
  const proxyBase = `http://127.0.0.1:${proxy.address().port}/api/v1`;
  const crash = async () => {
    await restart({ crash: true });
    crashRestarts++;
  };
  const checkpoint = async (journal) => {
    const path = `${output}/offline-journal.json`;
    await writeFile(path, JSON.stringify(journal), { mode: 0o600 });
    return JSON.parse(await readFile(path, 'utf8'));
  };
  try {
    const tournament = await call('/tournaments', {
      name: 'QA · Offline full tournament and lost responses',
      city: 'QA',
      venue: 'Private fault proxy',
      startDate: '2026-10-16',
      endDate: '2026-10-16',
      tatamiCount: 2,
    });
    const categories = [];
    for (const [format, count, year, weight] of [
      ['ROUND_ROBIN', 3, 2016, 30000],
      ['REPECHAGE', 8, 2012, 50000],
    ]) {
      const c = await call(`/tournaments/${tournament.id}/categories`, {
        name: 'QA ' + format,
        format,
        gender: 'MALE',
        birthYearFrom: year,
        birthYearTo: year + 1,
        maxWeightGrams: weight,
        durationSeconds: 180,
      });
      for (let i = 0; i < count; i++)
        await call(`/tournaments/${tournament.id}/categories/${c.id}/entries`, {
          firstName: 'QA',
          lastName: `${format}-${i}`,
          birthYear: year,
          club: `QA club-${i}`,
        });
      const draw = await call(`/categories/${c.id}/draw/preview`, {});
      assert.equal(draw.snapshot.tieRanking, 'WINS_ONLY');
      await call(`/categories/${c.id}/draw/confirm`, { version: draw.version });
      await call(`/categories/${c.id}/draw/publication`, { published: true, expectedRevision: 0 });
      categories.push(c);
    }
    await call(`/tournaments/${tournament.id}/publish`, {});
    await call(`/tournaments/${tournament.id}/start`, {});
    const [rr, rep] = await Promise.all(
      categories.map((c) =>
        db.category.findUniqueOrThrow({ where: { id: c.id }, include: { draw: true } }),
      ),
    );
    const mat = rr.homeTatamiId;
    const grant = await fixtureControl(base, mat, cookie);
    const dashboard = await call(`/tournaments/${tournament.id}/tatamis/${mat}`);
    const first = dashboard.queue[0];
    const commandPath = `/tatamis/${mat}/live/${first.id}/command`;
    let result = await call(commandPath, {
      id: randomUUID(),
      type: 'START',
      expectedVersion: first.revision,
      ...grant,
    });
    result = await call(commandPath, {
      id: randomUUID(),
      type: 'STOP',
      expectedVersion: result.revision,
      ...grant,
    });
    const view = await call(`/tatamis/${mat}/live`);
    const sessionId = randomUUID();
    let journal = {
      sessionId,
      view,
      state: result.state,
      revision: result.revision,
      opening: true,
      events: [],
      grant,
      packet: {
        id: randomUUID(),
        sessionId,
        type: 'OFFLINE_OPEN',
        expectedVersion: result.revision,
        ...grant,
      },
    };
    journal = await checkpoint(journal);
    const open = structuredClone(journal.packet);
    fault = { id: open.id, mode: 'disconnect' };
    await assert.rejects(call(commandPath, open, proxyBase));
    assert.equal(
      (await db.contest.findUniqueOrThrow({ where: { id: first.id } })).offlineSessionId,
      sessionId,
    );
    await crash();
    const opened = await call(commandPath, open, proxyBase);
    journal = acknowledgeJournalPacket(journal, open, opened).next;
    assert.deepEqual(await call(commandPath, open, proxyBase), opened);

    journal = appendJournalCommand(journal, { type: 'START' });
    for (let i = 0; i < 130; i++)
      journal = appendJournalCommand(journal, { type: 'ADVANCE', ms: 1 });
    journal.packet = {
      id: randomUUID(),
      sessionId,
      type: 'OFFLINE_SYNC',
      expectedVersion: journal.revision,
      ...grant,
      events: journal.events.slice(0, 128),
    };
    const members = rr.draw.snapshot.positions.map((e) => e.id);
    const delta =
      (members.indexOf(view.currentMatch.blue.id) -
        members.indexOf(view.currentMatch.white.id) +
        3) %
      3;
    const winningSide = delta === 1 ? 'WHITE' : 'BLUE';
    journal = appendJournalCommand(journal, { type: 'HOLD', side: winningSide });
    for (const ms of [5000, 5000, 10000])
      journal = appendJournalCommand(journal, { type: 'ADVANCE', ms });
    journal = appendJournalCommand(journal, { type: 'CONFIRM' });
    journal = await checkpoint(journal);
    assert.equal(journal.state.status, 'CONFIRMED');
    const packet1 = structuredClone(journal.packet),
      localFinal = structuredClone(journal.state);
    blocked = true;
    const before = await db.contest.findUniqueOrThrow({ where: { id: first.id } });
    await assert.rejects(call(commandPath, packet1, proxyBase));
    assert.deepEqual(await db.contest.findUniqueOrThrow({ where: { id: first.id } }), before);
    blocked = false;
    fault = { id: packet1.id, mode: 'disconnect' };
    await assert.rejects(call(commandPath, packet1, proxyBase));
    await crash();
    const prefix = await call(commandPath, packet1, proxyBase);
    journal = acknowledgeJournalPacket(await checkpoint(journal), packet1, prefix).next;
    assert.deepEqual(
      journal.state,
      localFinal,
      'prefix acknowledgement must preserve unsent local tail',
    );
    assert.equal(journal.events.length, 8);
    journal.packet = {
      id: randomUUID(),
      sessionId,
      type: 'OFFLINE_SYNC',
      expectedVersion: journal.revision,
      ...grant,
      events: structuredClone(journal.events),
    };
    journal = await checkpoint(journal);
    const packet2 = structuredClone(journal.packet);
    fault = { id: packet2.id, mode: 'malformed' };
    const malformed = await call(commandPath, packet2, proxyBase);
    assert.throws(
      () => acknowledgeJournalPacket(journal, packet2, malformed),
      /MATCH_RECEIPT_INVALID/,
    );
    assert.deepEqual((await checkpoint(journal)).packet, packet2);
    await crash();
    const confirmed = await call(commandPath, packet2, proxyBase);
    assert.equal(acknowledgeJournalPacket(journal, packet2, confirmed).archived, true);
    assert.deepEqual(confirmed.state, localFinal);
    const finishedFirst = await db.contest.findUniqueOrThrow({ where: { id: first.id } });
    assert.deepEqual(await call(commandPath, packet1, proxyBase), prefix);
    assert.deepEqual(
      await db.contest.findUniqueOrThrow({ where: { id: first.id } }),
      finishedFirst,
    );
    const eventIds = [...packet1.events, ...packet2.events].map((e) => e.id);
    assert.equal(await db.matchEvent.count({ where: { id: { in: eventIds } } }), eventIds.length);
    assert.equal(new Set(eventIds).size, 136);
    assert.equal(confirmed.state.awards.filter((a) => a.active && a.kind === 'IPPON').length, 1);

    const play = async (category, choose) => {
      for (let guard = 0; guard < 50; guard++) {
        const board = await call(`/tournaments/${tournament.id}/tatamis/${category.homeTatamiId}`);
        const next = board.queue.find((m) => !m.blockedByRound);
        if (!next) return;
        await db.contest.updateMany({
          where: { draw: { categoryId: category.id }, status: 'CONFIRMED' },
          data: { endedAt: new Date(0), confirmedAt: new Date(0) },
        });
        let s = await call(`/tatamis/${category.homeTatamiId}/live/${next.id}/command`, {
          id: randomUUID(),
          type: 'START',
          expectedVersion: next.revision,
        });
        s = await call(`/tatamis/${category.homeTatamiId}/live/${next.id}/command`, {
          id: randomUUID(),
          type: 'AWARD',
          expectedVersion: s.revision,
          side: choose(next),
          kind: 'IPPON',
        });
        await call(`/tatamis/${category.homeTatamiId}/live/${next.id}/command`, {
          id: randomUUID(),
          type: 'CONFIRM',
          expectedVersion: s.revision,
        });
      }
      throw new Error('OFFLINE_QA_UNBOUNDED_DRAW');
    };
    await play(rr, (m) =>
      (members.indexOf(m.blue.id) - members.indexOf(m.white.id) + 3) % 3 === 1 ? 'WHITE' : 'BLUE',
    );
    const review = (await call(`/categories/${rr.id}/draw/tiebreak-impact`)).reviews[0];
    assert.ok(review);
    const approval = {
      parent: review.parent,
      members: [...review.members].reverse(),
      procedure: 'ORDERED_PLACES',
    };
    const checked = await call(`/categories/${rr.id}/draw/tiebreak-impact`, approval);
    const decision = {
      ...approval,
      id: randomUUID(),
      expectedVersion: checked.expectedVersion,
      impactToken: checked.reviews[0].impactToken,
      reason: 'QA reviewed places after offline completion',
    };
    const decisionPath = `/categories/${rr.id}/draw/tiebreak`;
    fault = { id: decision.id, mode: 'disconnect' };
    await assert.rejects(call(decisionPath, decision, proxyBase));
    await crash();
    const receipt = await call(decisionPath, decision, proxyBase);
    assert.deepEqual(
      receipt.progress.places.map((p) => p.entryId),
      approval.members,
    );
    assert.deepEqual(await call(decisionPath, decision, proxyBase), receipt);
    assert.equal(await db.drawCommand.count({ where: { id: decision.id } }), 1);

    const quarters = rep.draw.snapshot.matches.filter(
      (m) => (!m.stage || m.stage === 'MAIN') && m.round === 1,
    );
    for (const [index, entryId] of [
      quarters[0].white.entryId,
      quarters[1].white.entryId,
    ].entries()) {
      const path = `/categories/${rep.id}/draw/withdrawal`;
      const preview = await call(path + '-impact', { entryId });
      const dto = {
        id: randomUUID(),
        entryId,
        expectedVersion: preview.expectedVersion,
        impactToken: preview.impactToken,
        reason: 'QA withdrawal with durable automatic propagation',
      };
      if (index === 0) {
        fault = { id: dto.id, mode: 'disconnect' };
        await assert.rejects(call(path, dto, proxyBase));
        await crash();
      }
      const withdrawal = await call(path, dto, proxyBase);
      assert.deepEqual(await call(path, dto, proxyBase), withdrawal);
      assert.equal(await db.drawCommand.count({ where: { id: dto.id } }), 1);
    }
    await play(rep, () => 'WHITE');
    assert.equal(
      (await db.tournament.findUniqueOrThrow({ where: { id: tournament.id } })).status,
      'FINISHED',
    );
    assert.equal(
      await db.contest.count({
        where: { draw: { categoryId: rep.id }, resultReason: 'NO_CONTEST' },
      }),
      1,
    );
    const categoryIds = categories.map((c) => c.id);
    const finalRows = await db.contest.findMany({
      where: { draw: { categoryId: { in: categoryIds } } },
      orderBy: { id: 'asc' },
    });
    const hashes = {};
    for (const kind of ['DRAW', 'PARTICIPANTS', 'TEAMS']) {
      const state = await call(`/tournaments/${tournament.id}`);
      const artifact = (
        await call(`/tournaments/${tournament.id}/protocols`, {
          id: randomUUID(),
          expectedRevision: state.protocolRevision,
          kind,
          lang: 'ru',
          reason: 'QA immutable final document after outage',
        })
      ).artifact;
      const revised = await call(`/tournaments/${tournament.id}`);
      await call(`/tournaments/${tournament.id}/protocols/${artifact.id}/command`, {
        id: randomUUID(),
        expectedRevision: revised.protocolRevision,
        type: 'PUBLISH',
        sha256: artifact.sha256,
        reason: 'QA publish final immutable document',
      });
      const path = `/public/tournaments/${tournament.id}/protocols/${artifact.id}.pdf`;
      const bytes = Buffer.from(await (await fetch(base + path)).arrayBuffer());
      assert.equal(bytes.subarray(0, 5).toString(), '%PDF-');
      hashes[path] = createHash('sha256').update(bytes).digest('hex');
    }
    await restart({ crash: false });
    assert.deepEqual(
      await db.contest.findMany({
        where: { draw: { categoryId: { in: categoryIds } } },
        orderBy: { id: 'asc' },
      }),
      finalRows,
    );
    for (const [path, hash] of Object.entries(hashes))
      assert.equal(
        createHash('sha256')
          .update(Buffer.from(await (await fetch(base + path)).arrayBuffer()))
          .digest('hex'),
        hash,
      );
    return {
      passed: true,
      tournamentId: tournament.id,
      schema: actual,
      inheritedSchema: schema ?? null,
      crashRestarts,
      gracefulRestarts: 1,
      offlineEventCount: eventIds.length,
      packetSizes: [128, 8],
      checks: [
        'real TCP disconnect before request',
        'response lost after OFFLINE_OPEN commit',
        'prefix response lost and API killed',
        'malformed 200 after final commit',
        'exact immutable retry after restart',
        'unsent journal tail retained',
        'one terminal hold award',
        'v4 cyclic group and manual places after crash',
        'withdrawal receipt and empty branch after crash',
        'complete tournament and three published PDF byte hashes after restart',
      ],
      limits: [
        'JSON checkpoint is not browser IndexedDB or service worker acceptance',
        'No physical power loss or venue Wi-Fi test',
      ],
    };
  } finally {
    proxy.closeAllConnections();
    await new Promise((resolve) => proxy.close(resolve));
  }
}
