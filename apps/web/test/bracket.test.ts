import assert from 'node:assert/strict';
import test from 'node:test';
import { createDraw, createMixed, generateDraw } from '@judo/engine/draw';
import {
  bracketNodes,
  layoutBracket,
  layoutMedalBracket,
  CARD_HEIGHT,
  CARD_WIDTH,
} from '../src/features/draws/bracket-layout.ts';
test('complete medal diagram retains every real repechage/bronze dependency for 6..128 entrants', () => {
  for (let n = 6; n <= 128; n++) {
    for (const format of ['REPECHAGE', ...(n >= 8 ? ['MIXED'] : [])]) {
      const draw = generateDraw(
        format,
        Array.from({ length: n }, (_, i) => ({ id: String(i), clubId: String(i % 3) })),
        17,
        'KNOCKOUT_FROM_SIX',
      );
      const layout = layoutMedalBracket(draw, 500);
      const expected = draw.matches.filter((m) => m.stage === 'REPECHAGE' || m.stage === 'BRONZE');
      assert.deepEqual(layout.cards.map((c) => c.matchId).sort(), expected.map((m) => m.id).sort());
      assert.equal(new Set(layout.cards.map((c) => c.id)).size, expected.length);
      for (const card of layout.cards) {
        const match = expected.find((m) => m.id === card.matchId)!;
        assert.deepEqual(card.white, match.white);
        assert.deepEqual(card.blue, match.blue);
        assert.ok(card.x >= 0 && card.x + CARD_WIDTH <= layout.width);
        assert.ok(card.y >= 500 && card.y + CARD_HEIGHT <= 500 + layout.height);
        for (const other of layout.cards.filter((c) => c.id !== card.id))
          assert.ok(
            card.x + CARD_WIDTH <= other.x ||
              other.x + CARD_WIDTH <= card.x ||
              card.y + CARD_HEIGHT <= other.y ||
              other.y + CARD_HEIGHT <= card.y,
          );
      }
      assert.equal(layout.lines.length, expected.filter((m) => m.stage === 'REPECHAGE').length);
      for (const line of layout.lines) {
        const bronze = expected.find((m) => m.id === line.to)!;
        assert.ok(
          [bronze.white, bronze.blue].some((s) => 'winnerOf' in s && s.winnerOf === line.from),
        );
      }
    }
  }
});
test('2..128: bracket preserves real contests, represents BYEs and has no overlapping cards', () => {
  for (let n = 2; n <= 128; n++) {
    const draw = createDraw(
      Array.from({ length: n }, (_, i) => ({ id: String(i), clubId: String(i % 5) })),
      34,
    );
    const nodes = bracketNodes(draw),
      rounds = Math.log2(draw.size);
    assert.equal(nodes.length, draw.size - 1);
    assert.equal(nodes.filter((v) => v.matchId).length, n - 1);
    for (const m of draw.matches) {
      const v = nodes.find((v) => v.id === m.id)!;
      assert.deepEqual(v.white, m.white);
      assert.deepEqual(v.blue, m.blue);
    }
    assert.equal(nodes.filter((v) => !v.matchId).length, draw.size - n);
    const layout = layoutBracket(nodes, {
      startRound: 1,
      endRound: rounds,
      startLeaf: 0,
      leafCount: draw.size,
    });
    assert.equal(layout.lines.length, nodes.length - 1);
    for (const c of layout.cards) {
      assert.ok(
        c.x >= 0 &&
          c.y >= 0 &&
          c.x + CARD_WIDTH <= layout.width &&
          c.y + CARD_HEIGHT <= layout.height,
      );
    }
    for (let r = 1; r <= rounds; r++) {
      const cards = layout.cards.filter((c) => c.round === r);
      for (let i = 1; i < cards.length; i++) assert.ok(cards[i].y >= cards[i - 1].y + CARD_HEIGHT);
    }
  }
});
test('quarter views plus final stage partition large brackets; connector endpoints are local', () => {
  for (const size of [16, 32, 64, 128]) {
    const draw = createDraw(
        Array.from({ length: size - 3 }, (_, i) => ({ id: String(i), clubId: 'c' })),
        2,
      ),
      nodes = bracketNodes(draw),
      r = Math.log2(size);
    const views = [
      ...[0, 1, 2, 3].map((i) => ({
        startRound: 1,
        endRound: r - 2,
        startLeaf: (i * size) / 4,
        leafCount: size / 4,
      })),
      { startRound: r - 1, endRound: r, startLeaf: 0, leafCount: size },
    ];
    const seen = new Set();
    for (const view of views) {
      const layout = layoutBracket(nodes, view);
      for (const c of layout.cards) {
        assert.ok(!seen.has(c.id));
        seen.add(c.id);
        assert.ok(c.y >= 0 && c.y + CARD_HEIGHT <= layout.height);
      }
      for (const line of layout.lines) assert.ok(layout.cards.some((c) => c.id === line.to));
    }
    assert.equal(seen.size, nodes.length);
  }
});

test('mixed knockout layout keeps domain match IDs and pool-place sources for sizes 4..128', () => {
  for (let n = 4; n <= 128; n++) {
    const draw = createMixed(
      Array.from({ length: n }, (_, i) => ({ id: String(i), clubId: String(i % 4) })),
      42,
    );
    const nodes = bracketNodes(draw),
      main = draw.matches.filter((m) => m.stage === 'MAIN');
    assert.equal(nodes.length, main.length);
    for (const m of main) {
      const node = nodes.find((n) => n.matchId === m.id)!;
      assert.ok(node);
      assert.deepEqual(node.white, m.white);
      assert.deepEqual(node.blue, m.blue);
    }
    const size = draw.pools!.length * 2;
    const layout = layoutBracket(nodes, {
      startRound: 1,
      endRound: Math.log2(size),
      startLeaf: 0,
      leafCount: size,
    });
    for (const c of layout.cards) assert.ok(c.y >= 0 && c.y + CARD_HEIGHT <= layout.height);
    assert.equal(layout.lines.length, main.length - 1);
  }
});
