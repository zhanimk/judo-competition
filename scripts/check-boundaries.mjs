import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
const root = fileURLToPath(new URL('../', import.meta.url));
async function files(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  return (
    await Promise.all(
      entries.map((e) =>
        e.isDirectory() ? files(new URL(e.name + '/', dir)) : [new URL(e.name, dir)],
      ),
    )
  ).flat();
}
function inside(file, directory) {
  const relative = path.relative(directory, file);
  return (
    relative === '' ||
    (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative))
  );
}

export function boundaryViolations(content, file, projectRoot, publicExports) {
  const errors = [];
  const engine = path.join(projectRoot, 'packages/engine');
  const engineSource = path.join(engine, 'src');
  const isEngine = inside(file, engineSource);
  // Covers static imports (including side effects), re-exports, and literal dynamic imports.
  const imports = /(?:\bfrom\s*|\bimport\s*(?:\(\s*)?|\brequire\s*\(\s*)['"]([^'"]+)['"]/g;
  for (const [, specifier] of content.matchAll(imports)) {
    const resolved = specifier.startsWith('.')
      ? path.resolve(path.dirname(file), specifier)
      : undefined;
    if (isEngine) {
      if (!resolved || !inside(resolved, engineSource))
        errors.push(`${file}: engine dependency outside its source: ${specifier}`);
      continue;
    }
    if (specifier === '@judo/engine' || specifier.startsWith('@judo/engine/')) {
      if (!publicExports.has(specifier))
        errors.push(`${file}: engine import is not a public export: ${specifier}`);
    } else if (
      (resolved && inside(resolved, engine)) ||
      /(?:^|\/)packages\/engine\//.test(specifier)
    ) {
      errors.push(`${file}: use public engine package exports: ${specifier}`);
    }
    if (
      (resolved && inside(resolved, path.join(projectRoot, 'archive'))) ||
      /(?:^|\/)archive\//.test(specifier)
    )
      errors.push(`${file}: archive is outside the application: ${specifier}`);
    if (
      (resolved && inside(resolved, path.join(projectRoot, 'apps'))) ||
      /(?:^|\/)apps\//.test(specifier)
    ) {
      const appName = path.relative(path.join(projectRoot, 'apps'), file).split(path.sep)[0];
      if (!resolved || !inside(resolved, path.join(projectRoot, 'apps', appName)))
        errors.push(`${file}: cross-application dependency: ${specifier}`);
    }
  }
  return errors;
}

export async function checkBoundaries(projectRoot = root) {
  const pkg = JSON.parse(
    await readFile(path.join(projectRoot, 'packages/engine/package.json'), 'utf8'),
  );
  const publicExports = new Set(
    Object.keys(pkg.exports).map((key) =>
      key === '.' ? '@judo/engine' : '@judo/engine' + key.slice(1),
    ),
  );
  const directories = [path.join(projectRoot, 'packages/engine/src')];
  for (const app of await readdir(path.join(projectRoot, 'apps'), { withFileTypes: true }))
    if (app.isDirectory()) directories.push(path.join(projectRoot, 'apps', app.name, 'src'));
  const errors = [];
  for (const directory of directories) {
    for (const file of await files(pathToFileURL(directory + path.sep))) {
      if (!/\.[cm]?[jt]sx?$/.test(file.pathname)) continue;
      errors.push(
        ...boundaryViolations(
          await readFile(file, 'utf8'),
          fileURLToPath(file),
          projectRoot,
          publicExports,
        ),
      );
    }
  }
  return errors;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const errors = await checkBoundaries();
  if (errors.length) {
    console.error(errors.join('\n'));
    process.exitCode = 1;
  } else
    console.log(
      'Dependency boundaries checked: independent engine, public imports in all applications.',
    );
}
