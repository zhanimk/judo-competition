import assert from 'node:assert/strict';
import { test } from 'node:test';
import { boundaryViolations } from '../check-boundaries.mjs';

const root = '/tmp/judo project';
const exports = new Set(['@judo/engine/draw', '@judo/engine/match']);
const check = (source, file) => boundaryViolations(source, root + '/' + file, root, exports);

test('both API and web can use only public engine exports', () => {
  for (const app of ['api', 'web']) {
    const file = `apps/${app}/src/module.ts`;
    assert.deepEqual(check("import type { Match } from '@judo/engine/match';", file), []);
    for (const source of [
      "import '@judo/engine/dist/match.js';",
      "export { Match } from '@judo/engine/src/match';",
      "const core = import( '../../../packages/engine/src/match.ts');",
      "import { x } from '../../../packages/engine/dist/match.js';",
      "import { x } from '@judo/engine';",
    ])
      assert.equal(check(source, file).length, 1, source);
  }
});

test('engine stays inside its source, including side effects and re-exports', () => {
  const file = 'packages/engine/src/match/index.ts';
  assert.deepEqual(check("export { Match } from './model.ts';", file), []);
  assert.deepEqual(check("import { draw } from '../draw/index.ts';", file), []);
  for (const source of [
    "import 'react';",
    "export * from 'node:fs';",
    "const data = import('../../test/fixtures.ts');",
    "import { x } from '../../src-other/match.ts';",
  ])
    assert.equal(check(source, file).length, 1, source);
});

test('application boundaries exclude the archive and other application sources', () => {
  assert.deepEqual(check("import { x } from '../shared/x';", 'apps/web/src/features/a.ts'), []);
  assert.equal(check("import { x } from '../../api/src/main';", 'apps/web/src/a.ts').length, 1);
  assert.equal(check("export * from '../../../archive/demo';", 'apps/api/src/a.ts').length, 1);
});
