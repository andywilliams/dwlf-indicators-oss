// Refuses the release before `npx semantic-release` if this tree cannot authenticate.
//
// This repository holds no npm token: publishing is authorized by a short-lived
// OIDC token (see RELEASING.md). Two things have to be true for that to work, and
// a routine pnpm-lock.yaml regeneration or runner change can break either one
// without touching release.yml.
//
//   1. semantic-release resolves plugin names from its OWN directory and walks up,
//      so a copy nested inside its dependency tree shadows the project root's.
//      Whichever one wins has to be v13+, because only v13+ establishes the OIDC
//      context; v12 goes straight to NPM_TOKEN, which this job does not have, and
//      fails at verifyConditions. Raising a root pin does not help while a stale
//      copy is nested below semantic-release — raise semantic-release itself.
//   2. That plugin publishes by shelling out to `npm publish` through execa with
//      `preferLocal: true`, which prepends node_modules/.bin to PATH. This repo has
//      no local npm, so the binary that authenticates is the first `npm` on PATH
//      (the one bundled with Node 24), unless a dependency starts providing
//      node_modules/.bin/npm. Only npm >= 11.5.1 can publish over OIDC.
//
// Either failure would otherwise surface as an authentication error at the registry,
// pointing at credentials rather than at the dependency tree that caused it.

import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';

const PLUGIN = '@semantic-release/npm';
const MIN_PLUGIN = '13.0.0';
const MIN_NPM = '11.5.1';
// semantic-release resolves from its own __dirname, which is the REAL path. Under
// pnpm node_modules/semantic-release is a symlink into .pnpm, and resolving through
// the symlink would find the project root's copy instead of the one that loads.
const PLUGINS_DIR = `${realpathSync(join(process.cwd(), 'node_modules/semantic-release/lib/plugins'))}/`;

function fail(message) {
  console.error(`::error::${message}`);
  process.exit(1);
}

const rel = (p) => p.replace(`${process.cwd()}/`, '');

// npm and plugin versions are plain x.y.z. Anything else is not something to guess
// about: return null so the caller refuses rather than comparing wrongly.
function atLeast(actual, minimum) {
  const parse = (v) => {
    const parts = String(v).trim().split('.');
    if (parts.length !== 3 || parts.some((p) => !/^\d+$/.test(p))) return null;
    return parts.map(Number);
  };
  const a = parse(actual);
  const m = parse(minimum);
  if (!a || !m) return null;
  for (let i = 0; i < 3; i += 1) {
    if (a[i] !== m[i]) return a[i] > m[i];
  }
  return true;
}

// The plugin blocks `./package.json` through its `exports`, and its entry point is
// not guaranteed to sit at the package root, so walk up from the resolved entry to
// the nearest package.json that actually names this package.
function manifestFor(entry) {
  let dir = dirname(entry);
  for (;;) {
    const candidate = join(dir, 'package.json');
    if (existsSync(candidate)) {
      try {
        const pkg = JSON.parse(readFileSync(candidate, 'utf8'));
        if (pkg.name === PLUGIN) return { dir, version: pkg.version };
      } catch {
        // Not this one; keep walking.
      }
    }
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

// 1. The plugin semantic-release will actually load.
let entry;
try {
  entry = createRequire(PLUGINS_DIR).resolve(PLUGIN);
} catch (error) {
  fail(`could not resolve ${PLUGIN} the way semantic-release does, from ${rel(PLUGINS_DIR)} — ${error.message}`);
}

const manifest = manifestFor(entry);
if (!manifest) {
  fail(`resolved ${PLUGIN} to ${rel(entry)} but found no package.json naming it above that path, so its version is unknown.`);
}

const pluginOk = atLeast(manifest.version, MIN_PLUGIN);
if (pluginOk === null) {
  fail(`could not read a version from ${rel(manifest.dir)}/package.json (got "${manifest.version}"), so OIDC support is unknown.`);
}
if (!pluginOk) {
  fail(
    `semantic-release loads ${PLUGIN} ${manifest.version} from ${rel(manifest.dir)}; v${MIN_PLUGIN} or later is required to publish over OIDC. ` +
      `This job holds no npm token, so the release would fail at verifyConditions with ENONPMTOKEN. ` +
      `Raise the semantic-release dependency so nothing stale nests below it — pinning ${PLUGIN} at the project root does not help while a nested copy shadows it.`,
  );
}
console.log(`${PLUGIN} ${manifest.version} from ${rel(manifest.dir)} — publishes over OIDC (>= ${MIN_PLUGIN}).`);

// 2. The npm binary that plugin will shell out to: node_modules/.bin/npm if a
// dependency provides one (preferLocal puts it first), otherwise the first npm on PATH.
const localNpm = join(process.cwd(), 'node_modules/.bin/npm');
const npmBin = existsSync(localNpm) ? localNpm : 'npm';

const npmVersion = execFileSync(npmBin, ['--version'], { encoding: 'utf8' }).trim();
const npmOk = atLeast(npmVersion, MIN_NPM);
if (npmOk === null) {
  fail(`could not read a version from ${rel(npmBin)} (got "${npmVersion}"), so trusted publishing support is unknown.`);
}
if (!npmOk) {
  fail(
    `${rel(npmBin)} is ${npmVersion}, which predates trusted publishing; npm >= ${MIN_NPM} is required. ` +
      `This is the npm that publishes, because the plugin shells out with execa preferLocal.`,
  );
}
console.log(`${rel(npmBin)} ${npmVersion} — publishes over OIDC (>= ${MIN_NPM}).`);
