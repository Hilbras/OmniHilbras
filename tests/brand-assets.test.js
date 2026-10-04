import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { inflateSync } from 'node:zlib';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

/**
 * The brand assets are generated, and this is the check that makes that mean something.
 *
 * The generator is not the guarantee. A generator nobody runs is a script; assets that are generated and
 * never compared are the same as hand-drawn ones, except the hand-drawn ones at least look deliberate.
 *
 * Every assertion below is against a **source of truth outside the generator** — `src/index.css` for colour,
 * the file's own declared dimensions for size — so a change to the theme has to be propagated or CI fails.
 * A guard that re-ran the generator and compared its output to itself would pass no matter what was wrong.
 */

const ROOT = join(import.meta.dirname, '..');
const BRAND = join(ROOT, 'brand');

/**
 * The theme tokens, read the way the generator reads them.
 *
 * Duplicated from the generator on purpose. Sharing the function would mean a bug in the parser silently
 * agreeing with itself; here the test has its own copy, so a change to the stylesheet has to be picked up in
 * two places or the comparison below fails.
 */
function themeTokens() {
  const css = readFileSync(join(ROOT, 'src/index.css'), 'utf8');
  const block = (theme) => {
    const start = css.indexOf(`[data-theme='${theme}']`);
    const open = css.indexOf('{', start);
    const close = css.indexOf('}', open);
    return css.slice(open + 1, close);
  };
  const token = (source, name) => {
    const match = new RegExp(`${name}\\s*:\\s*(#[0-9a-fA-F]{3,6})`).exec(source);
    if (!match) throw new Error(`${name} is missing from src/index.css`);
    return match[1].toLowerCase();
  };
  const dark = block('dark');
  return {
    gold: token(dark, '--gold'),
    goldBright: token(dark, '--gold-bright'),
    bg: token(dark, '--bg'),
    text: token(dark, '--text'),
  };
}

const rgb = (hex) => {
  const full = hex.replace('#', '');
  return [0, 2, 4].map((i) => Number.parseInt(full.slice(i, i + 2), 16));
};

/** Minimal PNG reader: header for the size, one IDAT for the pixels. Enough to assert on. */
function readPng(path) {
  const raw = readFileSync(path);
  assert.deepEqual(
    [...raw.subarray(0, 8)],
    [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
    `${path} is not a PNG`,
  );
  let offset = 8;
  let header = null;
  const idat = [];
  while (offset < raw.length) {
    const length = raw.readUInt32BE(offset);
    const type = raw.subarray(offset + 4, offset + 8).toString('latin1');
    const data = raw.subarray(offset + 8, offset + 8 + length);
    if (type === 'IHDR') {
      header = { width: data.readUInt32BE(0), height: data.readUInt32BE(4), depth: data[8], colourType: data[9] };
    }
    if (type === 'IDAT') idat.push(data);
    if (type === 'IEND') break;
    offset += 12 + length;
  }
  const bytes = inflateSync(Buffer.concat(idat));
  const stride = header.width * 4 + 1;
  return {
    ...header,
    at(x, y) {
      const start = y * stride + 1 + x * 4;
      return [bytes[start], bytes[start + 1], bytes[start + 2], bytes[start + 3]];
    },
  };
}

/**
 * The vertices of each shape in an SVG, grouped per shape, as absolute `"x,y"` strings.
 *
 * ## Why this is not a regex over the file
 *
 * Because `public/favicon.svg` writes `<path d="M32 10 42 22 …">` and `brand/logo.svg` writes
 * `<polygon points="32,10 42,22 …">`. Those are the same drawing in two syntaxes, and comparing the source
 * text reports a mismatch that is not there — which is how this test "failed" three times before it read a
 * single pixel.
 *
 * ## Three things about path syntax that each produced a confident wrong answer
 *
 * Not an error, a wrong number — which is the mode that matters, because a wrong number looks like a finding.
 *
 * 1. **Case is the meaning.** `M`/`L` are absolute and `m`/`l` are relative. Testing with `/m/i` conflates
 *    them, and the absolute kite `M32 10 42 22 …` was accumulated into `74,32` and `160,118`.
 * 2. **`Z` is `closepath`, not unknown.** Rejecting it was wrong; it is the most ordinary command in the file.
 * 3. **A `<path>` restates its `moveto`.** The shipped facet is `m32 10 4 14 …Z`, whose `moveto` is the
 *    kite's top point — also its closing point — so it appears twice around the four real corners. Grouping
 *    per shape, and dropping a trailing point equal to the first, compares the drawings rather than the
 *    syntax.
 *
 * Only the subset the mark uses is supported: `h`, `v`, curves and arcs throw rather than being misread. A
 * guard that returns plausible wrong numbers is worse than one that refuses.
 */
function shapes(svg) {
  const out = [];
  for (const match of svg.matchAll(/(?:points|d)="([^"]+)"/g)) {
    const body = match[1];

    if (match[0].startsWith('points')) {
      const list = [];
      for (const pair of body.match(/-?\d+(?:\.\d+)?\s*[,\s]\s*-?\d+(?:\.\d+)?/g) ?? []) {
        const [x, y] = pair.split(/[\s,]+/).map(Number);
        list.push(`${x},${y}`);
      }
      out.push(list);
      continue;
    }

    const tokens = body.match(/[a-z]|-?\d*\.?\d+(?:e[-+]?\d+)?/gi) ?? [];
    // Everything that is not `m`, `l` or `z` is refused, by name. An earlier version only listed `h` and `v`
    // in its unsupported set and then handled the rest in the loop — so a path using `C` produced *no*
    // tokens, no throw, and an empty shape list, which looks exactly like a shape that drew nothing. The
    // tokenizer now claims every letter so nothing can slip past unexamined.
    const unsupported = [...new Set(tokens.filter((token) => /^[a-z]$/i.test(token) && !/^[mlz]$/i.test(token)))];
    if (unsupported.length) {
      throw new Error(`brand geometry uses an unsupported path command: ${unsupported.join(' ')}`);
    }

    let cx = 0;
    let cy = 0;
    let current = null;
    let index = 0;
    while (index < tokens.length) {
      const command = tokens[index];
      if (/^z$/i.test(command)) {
        index += 1;
        continue;
      }
      if (!/^[ml]$/i.test(command)) {
        throw new Error(`unexpected token "${command}" in the brand mark's path data`);
      }
      // A `moveto` starts a shape; a `lineto` continues the current one.
      if (/^m$/i.test(command)) {
        current = [];
        out.push(current);
      }
      if (!current) throw new Error(`the brand mark's path data starts with ${command} and no moveto`);
      const relative = command === command.toLowerCase();
      index += 1;
      while (index < tokens.length && /^-?[\d.]/.test(tokens[index])) {
        const x = Number(tokens[index]);
        const y = Number(tokens[index + 1]);
        if (!Number.isFinite(x) || !Number.isFinite(y)) {
          throw new Error(`malformed path data in the brand mark near "${command}${x} ${y}"`);
        }
        cx = relative ? cx + x : x;
        cy = relative ? cy + y : y;
        current.push(`${cx},${cy}`);
        index += 2;
      }
    }
  }
  return out;
}

/** A closed shape, however it was written: a repeated final point is not a different drawing. */
const normaliseShape = (points) => {
  let list = points;
  while (list.length > 1 && list[0] === list.at(-1)) list = list.slice(0, -1);
  return list;
};

const near = (a, b, tolerance = 6) => Math.abs(a - b) <= tolerance;

test('the stylesheet still defines every token the generator reads', () => {
  // If a token is renamed or dropped, the generator throws and nothing is written — the correct outcome, but
  // a crash rather than a diagnosis. This says which token went missing.
  const tokens = themeTokens();
  for (const [name, value] of Object.entries(tokens)) {
    assert.match(value, /^#[0-9a-f]{6}$/, `${name} is not a 6-digit hex colour: ${value}`);
  }
});

test('every brand file exists, and nothing is left over in the directory', () => {
  const expected = [
    'logo.svg', 'logo-mark.svg', 'logo-maskable.svg', 'wordmark.svg',
    ...[16, 32, 48, 64, 128, 180, 512].map((n) => `logo-${n}.png`),
    'logo-maskable-192.png', 'logo-maskable-512.png',
  ];
  for (const name of expected) {
    assert.ok(existsSync(join(BRAND, name)), `brand/${name} is missing; run \`pnpm brand\``);
  }
  // A stale file is worse than a missing one: it looks like a supported size and is not generated, so it can
  // never be regenerated correctly and nobody notices it came from another geometry.
  const extra = readdirSync(BRAND).filter((name) => !expected.includes(name));
  assert.deepEqual(extra, [], `brand/ holds files the generator does not produce: ${extra.join(', ')}`);
});

test('each PNG is the size its filename claims', () => {
  for (const size of [16, 32, 48, 64, 128, 180, 512]) {
    const png = readPng(join(BRAND, `logo-${size}.png`));
    assert.equal(png.width, size, `logo-${size}.png is ${png.width}px wide`);
    assert.equal(png.height, size, `logo-${size}.png is ${png.height}px tall`);
    assert.equal(png.depth, 8);
    assert.equal(png.colourType, 6, 'expected RGBA, so the rounded corners can be transparent');
  }
  for (const size of [192, 512]) {
    const png = readPng(join(BRAND, `logo-maskable-${size}.png`));
    assert.equal(png.width, size);
    assert.equal(png.height, size);
  }
});

test("the plate is the stylesheet's dark background, and the mark is its gold", () => {
  // The assertion that catches the real bug. A factor-of-16 error in the un-premultiply step turned the plate
  // `#0c0b09` into beige `#c0b090` and clipped the gold kite to white — and every other check still passed,
  // because a PNG with the wrong colours is still a PNG of the right size with transparent corners.
  const tokens = themeTokens();
  const png = readPng(join(BRAND, 'logo-512.png'));
  const [br, bg, bb] = rgb(tokens.bg);
  const [gr, gg, gb] = rgb(tokens.gold);
  const [fr, fg, fb] = rgb(tokens.goldBright);

  // The plate: a point on the plate that the kite cannot reach.
  const plate = png.at(256, 30);
  assert.ok(near(plate[0], br) && near(plate[1], bg) && near(plate[2], bb),
    `the plate is rgb(${plate.slice(0, 3)}) but --bg is rgb(${br}, ${bg}, ${bb})`);
  assert.equal(plate[3], 255, 'the plate must be opaque');

  // The mark: the centre of the kite. The facet is `gold-bright` at 0.8, so either colour is acceptable and
  // the tolerance is generous because the rasteriser averages samples.
  const mark = png.at(256, 256);
  const isGold = near(mark[0], gr, 40) && near(mark[1], gg, 40) && near(mark[2], gb, 60);
  const isFacet = near(mark[0], fr, 40) && near(mark[1], fg, 40) && near(mark[2], fb, 60);
  assert.ok(isGold || isFacet, `the centre pixel rgb(${mark.slice(0, 3)}) is neither --gold nor --gold-bright`);
  assert.ok(mark[3] > 200, 'the mark must be opaque');
});

test('the corners are transparent and the centre is opaque', () => {
  const png = readPng(join(BRAND, 'logo-32.png'));
  for (const [x, y] of [[0, 0], [31, 0], [0, 31], [31, 31]]) {
    assert.equal(png.at(x, y)[3], 0, `the corner (${x}, ${y}) is opaque; the rounded plate is not cut out`);
  }
  assert.ok(png.at(16, 16)[3] > 200, 'the centre of a 32px icon should be opaque');
});

test('the mark is present, not just the plate', () => {
  // Guards the opposite failure from a blank or all-one-colour file, which satisfies every colour assertion
  // above as long as the sampled points happen to be the plate.
  const png = readPng(join(BRAND, 'logo-512.png'));
  let markPixels = 0;
  for (let y = 0; y < 512; y += 2) {
    for (let x = 0; x < 512; x += 2) {
      const [r, g, b, a] = png.at(x, y);
      if (a > 200 && r > 150 && g > 110 && b < g) markPixels += 1;
    }
  }
  assert.ok(markPixels > 500, `only ${markPixels} gold pixels found; the kite is missing or tiny`);
});

test('the 16px icon has antialiased edges, not stair-steps', () => {
  // Supersampling is the difference between a favicon that looks deliberate at the one size it is judged at
  // and one that does not. Removing `SUPERSAMPLE` produces a file of the right size, with the right colours
  // and transparent corners — every other assertion here still passes — and a visibly stepped diagonal.
  //
  // Measured on `logo-48.png`: 194 partially-transparent pixels with 4x4 sampling, 100 with none. The
  // threshold is set below the real figure so ordinary tuning does not trip it, and above the unsampled one
  // so removing supersampling does.
  const png = readPng(join(BRAND, 'logo-48.png'));
  let soft = 0;
  for (let y = 0; y < png.height; y += 1) {
    for (let x = 0; x < png.width; x += 1) {
      const alpha = png.at(x, y)[3];
      if (alpha > 0 && alpha < 255) soft += 1;
    }
  }
  assert.ok(soft >= 150, `only ${soft} antialiased pixels in the 48px icon; the edges are stair-stepped, so ` +
    'supersampling is off or too low');
});

test('the maskable mark stays inside the crop circle', () => {
  // Android crops a maskable icon to a circle inscribed in the square, so anything in the outer ~11% of each
  // edge can be cut away. The mark is inset to 78% and the plate is full-bleed with square corners, which is
  // what makes this pass — publishing the normal icon as `maskable` is the usual mistake, and it clips the
  // point off the kite.
  const png = readPng(join(BRAND, 'logo-maskable-512.png'));
  const isMark = ([r, g, b, a]) => a > 200 && r > 150 && g > 110 && b < g;

  // Every pixel in the outer 8% of each edge, not a hand-picked list of rows and columns. The first version
  // sampled `[0, 1, 2, 4, 8, 16, 32, …]` and a mark scaled to 100% slipped between them — the mutation was
  // NOT caught, because 15 chosen rows out of 512 is not the same question as "does anything reach the edge".
  // The crop is a circle inscribed in the square, so the honest boundary is the inscribed circle itself:
  // a mark pixel outside it can be cut away.
  // The mark's **bounding box**, not its distance from the centre.
  //
  // The first version asked "is any mark pixel outside the inscribed crop circle?" and it was NOT able to
  // tell a correctly-inset maskable icon from an un-inset one: the kite is narrow, so at 100% its furthest
  // pixel sits at 135 of a possible 256 — nowhere near the boundary either way. A guard whose threshold is
  // 130 units away from every value it must distinguish is not a guard.
  //
  // Measured on `logo-maskable-512.png`: 124 px at the shipped 0.78 scale, 160 px at 1.0, 48 px at 0.3. The
  // upper bound below separates the first two with room for ordinary tuning, and the lower bound separates
  // "inset" from "shrunk to a speck" — a maskable icon that survives the crop by being invisible is also wrong.
  // `minX` is a `let` because it is seeded to "not seen yet" and then moved; `const minY` above was a
  // transcription slip that failed with "Assignment to constant variable" rather than anything meaningful.
  let minX = 512;
  let minY = 512;
  let maxX = -1;
  let maxY = -1;
  let count = 0;
  for (let y = 0; y < 512; y += 1) {
    for (let x = 0; x < 512; x += 1) {
      if (!isMark(png.at(x, y))) continue;
      count += 1;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  assert.ok(count > 200, `only ${count} mark pixels in the maskable icon; the mark is missing`);
  const width = maxX - minX + 1;
  const height = maxY - minY + 1;
  assert.ok(width <= 320 && height <= 320,
    `the maskable mark spans ${width}x${height} of 512px; it is not inset and Android will crop it`);
  assert.ok(width >= 80 && height >= 80,
    `the maskable mark spans only ${width}x${height}px; it is inset so far that it is barely visible`);

  // And it must still be centred: an off-centre mark survives the crop and is cropped anyway.
  const centreX = (minX + maxX) / 2;
  const centreY = (minY + maxY) / 2;
  assert.ok(Math.abs(centreX - 256) <= 16 && Math.abs(centreY - 256) <= 16,
    `the maskable mark is centred at (${centreX}, ${centreY}) rather than (256, 256)`);

  // And the plate must be full-bleed: a rounded maskable plate is cropped anyway, so rounding is invisible and
  // a transparent corner shows as a notch.
  assert.equal(png.at(0, 0)[3], 255, 'the maskable plate is not full-bleed; the corner will be cut');
});

test('the vector assets use the stylesheet colours and rounded coordinates', () => {
  const tokens = themeTokens();
  for (const name of ['logo.svg', 'logo-mark.svg', 'logo-maskable.svg']) {
    const svg = readFileSync(join(BRAND, name), 'utf8');
    assert.ok(svg.includes(tokens.gold), `${name} does not use --gold (${tokens.gold})`);
  }
  const wordmark = readFileSync(join(BRAND, 'wordmark.svg'), 'utf8');
  assert.ok(wordmark.includes(tokens.gold), 'the wordmark does not use --gold');
  assert.ok(wordmark.includes(tokens.text), 'the wordmark does not use --text for its primary word');

  // Coordinates rounded on the way out. A committed `59.519999999999996` bloats the file and looks broken when
  // the SVG is opened in an editor.
  for (const name of ['logo.svg', 'logo-mark.svg', 'logo-maskable.svg', 'wordmark.svg']) {
    const svg = readFileSync(join(BRAND, name), 'utf8');
    const longFloats = svg.match(/\d+\.\d{5,}/g) ?? [];
    assert.deepEqual(longFloats, [], `${name} has unrounded coordinates: ${longFloats.slice(0, 3).join(', ')}`);
  }
});

test('the shipped public/favicon.svg draws the same mark as brand/logo.svg', () => {
  // Two copies of one drawing is the drift this project keeps removing elsewhere. The favicon predates the
  // generator, so it is asserted equal rather than replaced: if the geometry ever moves deliberately, this
  // fails and the favicon is updated in the same commit.
  const shipped = readFileSync(join(ROOT, 'public/favicon.svg'), 'utf8');
  const generated = readFileSync(join(BRAND, 'logo.svg'), 'utf8');

  const a = shapes(shipped).map(normaliseShape);
  const b = shapes(generated).map(normaliseShape);
  assert.ok(a.length > 0 && b.length > 0, 'a favicon or logo drew no shapes');
  assert.equal(a.length, 2, `expected the kite and its facet, got ${a.length} shapes`);
  assert.deepEqual(a, b, 'public/favicon.svg no longer draws the same mark as brand/logo.svg');

  // The plate and the facet's opacity are part of the drawing too.
  for (const [name, svg] of [['public/favicon.svg', shipped], ['brand/logo.svg', generated]]) {
    assert.match(svg, /rx="16"/, `${name} lost the rounded plate`);
    assert.match(svg, /opacity="\.8"/, `${name} lost the facet's opacity`);
  }
});

test('the shape parser refuses what it cannot read, rather than returning wrong numbers', () => {
  // The parser's own failure mode: three of its bugs returned confident wrong coordinates. A guard that
  // throws on an unsupported command is the thing that stops the fourth.
  assert.throws(() => shapes('<path d="M0 0 H10 V10 Z" fill="#fff"/>'), /unsupported path command: H V/);
  // `C` is caught by the same gate as `H` and `V`. An earlier version's tokenizer only matched a fixed list
  // of letters, so `C` matched nothing at all: no token, no throw, and an empty shape list that reads as a
  // shape that drew nothing. That is the exact failure this test exists to prevent.
  assert.throws(() => shapes('<path d="M0 0 C1 1 2 2 3 3" fill="#fff"/>'), /unsupported path command: C/);

  // The two syntaxes it does support agree.
  assert.deepEqual(
    shapes('<polygon points="1,2 3,4 5,6"/>'),
    shapes('<path d="M1 2 3 4 5 6Z"/>'),
  );
  // A relative path resolves to the same place as its absolute equivalent — the case bug, asserted.
  assert.deepEqual(
    shapes('<path d="m10 10 l2 0 l0 2 Z"/>'),
    shapes('<path d="M10 10 L12 10 L12 12 Z"/>'),
  );
});

test('the generator is deterministic: same input, byte-identical output', () => {
  // If this fails, the committed files cannot be reproduced and the other checks are comparing against
  // something nobody can regenerate.
  //
  // **Off by default**, because regenerating all thirteen files takes ~29 s and this project's suite runs
  // hundreds of tests in a few seconds. Making every `pnpm test` pay half a minute to re-derive assets that
  // cannot have changed without someone editing the generator is a bad trade. It is the one check here that
  // is not about the committed files' contents, so `BRAND_STRICT=1` is how you ask for it — and `pnpm verify`
  // sets it, so nothing ships without it having run.
  if (process.env.BRAND_STRICT !== '1') return;

  const before = readdirSync(BRAND).sort().map((name) => [name, readFileSync(join(BRAND, name)).toString('base64')]);
  const run = spawnSync(process.execPath, ['scripts/generate-brand.mjs'], { cwd: ROOT, encoding: 'utf8' });
  assert.equal(run.status, 0, `the generator failed: ${run.stderr}`);
  const after = readdirSync(BRAND).sort().map((name) => [name, readFileSync(join(BRAND, name)).toString('base64')]);
  assert.deepEqual(after, before, 'regenerating changed the files; the generator is not deterministic');
});

test('something actually sets BRAND_STRICT, so the determinism check cannot quietly stop running', () => {
  // The check above is silent when the variable is unset, which is exactly the shape of a check that
  // disappears. So the environment that runs the full gate has to set it, asserted here rather than trusted
  // to a package.json nobody reads.
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  assert.match(JSON.stringify(pkg.scripts ?? {}), /BRAND_STRICT=1/,
    'no script sets BRAND_STRICT=1, so the determinism check never runs — including in CI');
  assert.match(pkg.scripts.verify, /test:brand/,
    'pnpm verify does not run the brand suite, so a stale asset would ship');
});

test('the npm package carries the same mark the repository does', () => {
  // npmjs.com renders the package's own README, which references `./brand/wordmark.svg`. That is a copy,
  // and a copy made by hand is the second source of truth this whole exercise exists to remove — it ships
  // whatever geometry was current when someone remembered to run `cp`. So the copy is generated, and this
  // asserts it is byte-identical rather than merely present.
  const SDK_BRAND = join(ROOT, 'packages/omnihilbras-sdk/brand');
  assert.ok(existsSync(SDK_BRAND), 'packages/omnihilbras-sdk/brand is missing; run `pnpm brand`');
  for (const name of ['logo.svg', 'logo-mark.svg', 'wordmark.svg', 'logo-512.png']) {
    assert.ok(existsSync(join(SDK_BRAND, name)), `the npm package is missing brand/${name}`);
    assert.deepEqual(
      readFileSync(join(SDK_BRAND, name)),
      readFileSync(join(BRAND, name)),
      `packages/omnihilbras-sdk/brand/${name} differs from brand/${name}; the copy is stale`,
    );
  }
  // Nothing extra: the Android maskable set has no place on an npm page and costs every consumer bytes.
  const shipped = readdirSync(SDK_BRAND).sort();
  assert.deepEqual(shipped, ['logo-512.png', 'logo-mark.svg', 'logo.svg', 'wordmark.svg'],
    `the npm package ships brand files the generator does not produce there: ${shipped.join(', ')}`);

  // And the SDK README must actually reference it, or shipping the copy is pointless.
  const readme = readFileSync(join(ROOT, 'packages/omnihilbras-sdk/README.md'), 'utf8');
  assert.match(readme, /brand\/wordmark\.svg/,
    'the SDK README does not show the wordmark, so the copy in the tarball is never rendered');
});

test('the package manifest ships brand/, or the copy is dead weight', () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'packages/omnihilbras-sdk/package.json'), 'utf8'));
  assert.ok(
    (pkg.files ?? []).includes('brand'),
    'packages/omnihilbras-sdk/package.json does not list `brand` in `files`, so npm will exclude it and the ' +
      'README image on npmjs.com will 404',
  );
});

test('the root README shows the wordmark', () => {
  const readme = readFileSync(join(ROOT, 'README.md'), 'utf8');
  assert.match(readme, /brand\/wordmark\.svg/, 'the root README does not show the wordmark');
  // Before the badges, so it is the first thing the page renders.
  assert.ok(readme.indexOf('wordmark.svg') < readme.indexOf('img.shields.io'),
    'the wordmark should come before the badge row');
});

test('the wordmark does not clip its own text', () => {
  // This is the bug the DOM found and no other test could. Every assertion in this file passed while the
  // wordmark rendered as **"OmniHilbra"** — the final "s" cut off at the plate's edge — because they all
  // checked colours, sizes and coordinates, and none of them looked at the drawing.
  //
  // There is no font engine here to measure a glyph run with, so the check uses the generator's own advance
  // table and asserts the plate is wide enough for the text it claims to hold, with margin. The table was
  // calibrated against a browser's `getComputedTextLength()` on this exact string: **554 px** at
  // `font-size: 92`, against a declared width of 860 with the text starting at 264 — 42 px of slack.
  //
  // The first version used `font-size: 104` (0.52 of the plate) in an 820 px canvas, and the run reached
  // past the edge. Measured slack is therefore the assertion, not the font size: whatever the generator
  // chooses, the name has to fit.
  const svg = readFileSync(join(BRAND, 'wordmark.svg'), 'utf8');
  const width = Number(/width="(\d+)"/.exec(svg)?.[1]);
  const textX = Number(/<text x="(\d+)"/.exec(svg)?.[1]);
  const fontSize = Number(/font-size="(\d+)"/.exec(svg)?.[1]);
  const letterSpacing = Number(/letter-spacing="(-?\d+)"/.exec(svg)?.[1]);
  assert.ok(Number.isFinite(width) && width > 0, 'the wordmark has no width');
  assert.ok(Number.isFinite(textX) && Number.isFinite(fontSize), 'the wordmark text has no position or size');

  // The string the plate has to hold, taken from the file rather than repeated here.
  const inner = /<text[^>]*>([^<]*)<tspan[^>]*>([^<]*)<\/tspan>/.exec(svg);
  assert.ok(inner, 'the wordmark text does not carry a primary and a secondary word');
  const word = inner[1] + inner[2];
  assert.equal(word, 'OmniHilbras', `the wordmark reads ${JSON.stringify(word)}`);

  // The same advance table the generator uses, restated so a change to either is caught here.
  const advance = { O: 0.79, m: 0.90, n: 0.60, i: 0.26, H: 0.75, l: 0.26, b: 0.60, r: 0.38, a: 0.56, s: 0.52 };
  let em = 0;
  for (const character of word) {
    assert.ok(advance[character] !== undefined, `no advance width for ${JSON.stringify(character)} in the wordmark`);
    em += advance[character];
  }
  const textWidth = em * fontSize + letterSpacing * word.length;
  assert.ok(
    textX + textWidth < width,
    `the wordmark text needs ${Math.round(textX + textWidth)}px but the plate is ${width}px; ` +
      `"${word}" would be clipped`,
  );
  // And not wastefully wide either: a plate 2x the text reads as two separate marks.
  assert.ok(
    width - (textX + textWidth) < textWidth * 0.5,
    `the wordmark plate is ${width}px for ${Math.round(textWidth)}px of text; it is far wider than it needs to be`,
  );
});

test('the root logo.png is generated, not uploaded by hand', () => {
  // `logo.png` at the repository root is the conventional project logo, and it was first committed by hand
  // via the API — a copy that ships whatever geometry was current that day. The generator now writes it, so
  // assert it is byte-identical to the source rather than merely present.
  const root = join(ROOT, 'logo.png');
  assert.ok(existsSync(root), 'logo.png is missing from the repository root; run `pnpm brand`');
  assert.deepEqual(
    readFileSync(root),
    readFileSync(join(BRAND, 'logo-512.png')),
    'logo.png differs from brand/logo-512.png; the root copy is stale',
  );
});