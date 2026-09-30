import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

/**
 * The rule that every gateway route is documented, made checkable.
 *
 * ## The rule, and why it needed a mechanism
 *
 * `AGENTS.md` says:
 *
 * > New gateway routes need tests in `apps/gateway/test/` and a line in `docs/SPEC-SDK.md`.
 *
 * A rule nobody can run is a rule that survives on attention. Measured, six of twenty-seven routes
 * the gateway serves had no line in the spec — and one of them is a route that **ingests a pasted
 * provider credential**:
 *
 * ```
 * /v1/oauth/kiro/import-token    ← undocumented, and untested
 * ```
 *
 * That is the shape this repository keeps finding: a rule stated once, no second copy to disagree
 * with it, and no check, so the gap is invisible until someone reads the whole route table against
 * the whole spec by hand. The `AGENTS.md` instruction to add a spec line is not a substitute for
 * this file — it is the thing that fails when the instruction is forgotten.
 *
 * ## Both directions, because each catches a different lie
 *
 * Forward: every path the code matches has a spec line. This is the direction the rule is about, and
 * it is the one that let six routes through.
 *
 * Reverse: every route the spec lists is a path the code matches. **A spec that documents a route
 * which no longer exists is worse than one that omits a new route**, because a reader has no way to
 * tell which kind of wrong they are looking at, and the omission at least shows up as a 404. The
 * reverse check is currently clean, which is not a reason to skip it — it is a reason to keep it,
 * because the day someone renames a path the spec will otherwise keep describing the old one
 * confidently.
 *
 * ## Comments are stripped, on purpose
 *
 * Both sides are searched for text, so both can be satisfied by prose. `routes/oauth.ts` documents
 * its handlers in doc comments that quote paths, and a naive matcher would let a comment vouch for a
 * route the spec never mentions. Comments are removed before matching — a spec line is a claim about
 * the spec, and a comment is not a line in it.
 */
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SPEC = join(ROOT, 'docs', 'SPEC-SDK.md');
const SOURCE_DIR = join(ROOT, 'apps', 'gateway', 'src');

/** Removes block and line comments without damaging a `//` inside a URL. */
function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

/** Every source file the route table is assembled from. */
function sourceFiles() {
  return [join(SOURCE_DIR, 'server.ts'), join(SOURCE_DIR, 'oauth.ts'), ...readdirSync(join(SOURCE_DIR, 'routes')).map((file) => join(SOURCE_DIR, 'routes', file))];
}

/** Module-level string constants, so a path held in a named constant is still checkable. */
function stringConstants() {
  const constants = new Map();
  for (const file of sourceFiles()) {
    const source = stripComments(readFileSync(file, 'utf8'));
    for (const match of source.matchAll(/(?:const|export const)\s+([A-Za-z_$][\w$]*)\s*=\s*['"`]([^'"`]*)['"`]/g)) {
      constants.set(match[1], match[2]);
    }
  }
  return constants;
}

/** Every literal path the gateway matches on, with any named constant resolved. */
function servedPaths() {
  const constants = stringConstants();
  const paths = new Set();
  const unresolved = [];
  for (const file of sourceFiles()) {
    const source = stripComments(readFileSync(file, 'utf8'));
    // A path is either a literal, a bare named constant (`url.pathname === clineCallbackPath`), or a
    // literal with a constant interpolated into it. All three are resolved to text, because a path
    // that cannot be resolved to text cannot be checked against the spec — and a route nobody can
    // check is a route nobody can be reminded to document.
    for (const match of source.matchAll(/url\.pathname\s*(?:===|\.endsWith\(|\.startsWith\()\s*(?:['"`]([^'"`]*)['"`]|([A-Za-z_$][\w$]*))/g)) {
      let path = match[1];
      if (path === undefined) path = constants.get(match[2]);
      else path = path.replace(/\$\{([A-Za-z_$][\w$]*)\}/g, (_, name) => constants.get(name) ?? `\${${name}}`);
      if (path === undefined || path.includes('${')) unresolved.push(`${file}: ${match[0].trim()}`);
      else paths.add(path);
    }
  }
  return { paths: [...paths].sort(), unresolved };
}

/** The routes the spec advertises, as `[method, path]` from its markdown list. */
function documentedRoutes() {
  const spec = readFileSync(SPEC, 'utf8');
  const routes = [];
  for (const match of spec.matchAll(/^-\s+`(GET|POST|PUT|PATCH|DELETE)\s+(\/[^`]*)`/gm)) {
    routes.push([match[1], match[2]]);
  }
  return routes;
}

/**
 * Whether a documented path corresponds to a served one.
 *
 * `:providerId` in the spec stands for whatever the caller sent, so paths are compared by shape. The
 * alternative — asking the spec to list every provider — is exactly the mistake this guard exists to
 * prevent: it would put provider names back into the route table.
 *
 * A served *prefix* counts as covering a documented route below it, because that is how the gateway
 * actually dispatches: `startsWith('/v1/keys/')` serves `PATCH /v1/keys/:id`, and treating those as
 * unrelated is how the first version of this guard reported five real routes as phantoms.
 */
function correspondsTo(documented, served) {
  const shape = (value) => value.replace(/:[a-zA-Z]+/g, ':param').replace(/\/$/, '');
  const target = shape(documented);
  return served.some((path) => {
    const candidate = shape(path);
    return candidate === target || target.startsWith(`${candidate}/`) || candidate.startsWith(`${target}/`);
  });
}

test('every path the gateway serves has a line in the spec', () => {
  const spec = readFileSync(SPEC, 'utf8');
  const undocumented = servedPaths().paths.filter((path) => !spec.includes(path));
  assert.deepEqual(
    undocumented,
    [],
    `these routes are served but not documented in docs/SPEC-SDK.md: ${undocumented.join(', ')}. ` +
      'AGENTS.md requires a spec line per route, and a route nobody documented is a route nobody ' +
      'knows the credential handling of.',
  );
});

test('every route path is text a machine can read, so it can be checked against the spec', () => {
  // A path assembled from something this guard cannot resolve — a function call, a computed
  // segment — is invisible to every check here, and an invisible route is an undocumented one. This
  // keeps the blind spot closed: a new route must be a literal, or a constant holding one.
  const { unresolved } = servedPaths();
  assert.deepEqual(
    unresolved,
    [],
    'these route paths are built from something that is not a literal or a named string constant, ' +
      'so no check in this suite can see them. Hoist the path to a constant.',
  );
});

test('every route the spec advertises is actually served', () => {
  const served = servedPaths().paths;
  const phantom = documentedRoutes().filter(([, path]) => !correspondsTo(path, served));
  assert.deepEqual(
    phantom.map(([method, path]) => `${method} ${path}`),
    [],
    'the spec lists routes the code does not serve. A documented route that 404s reads as a bug in ' +
      'the gateway, and the reader has no way to tell it is a leftover.',
  );
});

test('a route that ingests a credential is documented, because its credential handling is the point', () => {
  // Not a general rule about credentials — a specific one about the routes that accept a secret
  // pasted by a user, because those are the routes whose body shape, validation order, and what
  // actually gets stored are the whole design. `import-token` spends the pasted token and stores the
  // *access* token, which is a decision a reader needs written down, and it was not.
  const spec = readFileSync(SPEC, 'utf8');
  for (const path of servedPaths().paths.filter((candidate) => /import-token|exchange|api-key|connect$/.test(candidate))) {
    assert.ok(spec.includes(path), `${path} accepts a pasted credential and is not described in the spec`);
  }
});

test('THE COUNT, asserted so it cannot drift quietly', () => {
  // The number is the finding: six routes were served and undocumented when this guard was written.
  // Asserted rather than recorded so that a new undocumented route cannot be added by accident, and
  // so a reader sees the size of the gap rather than having to count again.
  const { paths } = servedPaths();
  assert.ok(paths.length >= 27, `expected the gateway's route table to be at least this large, found ${paths.length}`);
  assert.ok(documentedRoutes().length >= 20, 'the spec documents a substantial route table');
  console.log(`    routes served: ${paths.length}   documented: ${documentedRoutes().length}`);
});
