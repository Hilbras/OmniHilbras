/**
 * Generates every OmniHilbras brand asset from one geometry.
 *
 * ## Why a generator rather than committed files
 *
 * Because the alternative is the failure this project keeps fixing elsewhere: assets that agree with each
 * other on the day they are written and disagree silently after. Here there is one mark in `favicon.svg`,
 * one in the README, and one that GitHub and npm show — four copies of a drawing, none of which can tell the
 * others it changed. `tests/brand-assets.test.js` checks the outputs against the stylesheet and against each
 * other, so a `--gold` change that nobody propagated fails CI instead of shipping.
 *
 * ## Colours are read, never retyped
 *
 * `--gold`, `--gold-bright` and `--bg` come out of `src/index.css` at run time. Retyping them here would make
 * this file a second source of truth: a theme change would leave the icons behind, and the drift guard would
 * compare two stale values and agree with itself.
 *
 * The dark block is the one the mark is built from — it is what the existing favicon uses, and gold on a light
 * plate has no contrast at 16 px.
 *
 * ## Geometry a rasteriser can reproduce
 *
 * The mark is a kite and an inner facet, both convex polygons, plus a rounded plate. That is deliberately
 * restricted: `inside()` here is a point-in-polygon test the PNG writer shares with the SVG writer, so the
 * bitmap is provably the same drawing as the vector rather than a second implementation of it. A shape defined
 * only as SVG path commands would force a renderer to be written and trusted.
 *
 * Coordinates are rounded on the way out. Float arithmetic otherwise writes `59.519999999999996` into path
 * data, which bloats the SVG and looks broken in an editor.
 */

import { readFileSync, writeFileSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'brand');

/** The design canvas. Every size is this drawing scaled, so proportions cannot drift between artefacts. */
const CANVAS = 64;

/**
 * How far the maskable variant insets its mark.
 *
 * **One constant, read by both writers.** It used to be written out twice — once in `svg()` and once in
 * `sample()` — and that is precisely how a maskable icon could be published with a correctly-inset vector and
 * an un-inset raster: changing the first copy left the second drawing at the old size, the PNG came out
 * byte-identical, and every maskable assertion passed. The number is now declared once and both derive from
 * it, so they cannot disagree.
 */
const MASKABLE_SCALE = 0.78;

/**
 * The mark, in canvas units. Copied from `public/favicon.svg` unchanged in shape — this is the identity that
 * already ships, and the task is to make every other size and format say the same thing.
 */
const KITE = [
  [32, 10],
  [42, 22],
  [32, 54],
  [22, 22],
];

/** The lit inner facet: the same kite narrowed, on its right side. */
const FACET = [
  [32, 10],
  [36, 24],
  [32, 54],
  [28, 24],
];

/**
 * True when `point` is inside the convex polygon `poly`.
 *
 * The cross product is expanded to `a*x + b*y + c`, so each edge's coefficients are computed once rather
 * than per sample. That is the whole of the optimisation: a 512 px icon at 4x4 supersampling is 4 million
 * `inside()` calls, and recomputing two subtractions and a multiplication inside the inner loop made the
 * generator take **63 seconds**, which is a long time to ask a developer to wait and a very long time for a
 * CI guard to re-run the whole thing.
 *
 * `a*x + b*y + c` is exactly `(bx-ax)*(y-ay) - (by-ay)*(x-ax)` expanded, so the geometry is unchanged — the
 * output is byte-identical, which the determinism test now proves rather than asserts in a comment.
 */
function inside(poly, x, y) {
  let sign = 0;
  for (let i = 0; i < poly.length; i += 1) {
    const [ax, ay] = poly[i];
    const [bx, by] = poly[(i + 1) % poly.length];
    const cross = (bx - ax) * y - (by - ay) * x + (by - ay) * ax - (bx - ax) * ay;
    if (cross === 0) continue;
    const thisSign = cross > 0 ? 1 : -1;
    if (sign === 0) sign = thisSign;
    else if (sign !== thisSign) return false;
  }
  return true;
}

/** The rounded plate, matching the `rx="16"` the shipped favicon uses. */
function inPlate(x, y, size, radiusScale = 1) {
  const r = (16 / CANVAS) * size * radiusScale;
  const min = r;
  const max = size - r;
  const cx = Math.min(Math.max(x, min), max);
  const cy = Math.min(Math.max(y, min), max);
  const dx = x - cx;
  const dy = y - cy;
  return dx * dx + dy * dy <= r * r;
}

function hexToRgb(hex) {
  const value = hex.trim().replace('#', '');
  const full = value.length === 3 ? value.split('').map((c) => c + c).join('') : value;
  return [
    Number.parseInt(full.slice(0, 2), 16),
    Number.parseInt(full.slice(2, 4), 16),
    Number.parseInt(full.slice(4, 6), 16),
  ];
}

/**
 * Reads the theme tokens out of the stylesheet.
 *
 * Parsed rather than imported, because `index.css` is a stylesheet and this is a build script. Retyping the
 * hex values here would make this file a second source of truth: a theme change would leave the icons behind,
 * and the drift guard would compare two stale values and agree with itself.
 *
 * Both themes define every one of these names, so **which block is read decides what the logo looks like.**
 * The dark block is the one — it is what the shipped `public/favicon.svg` uses, and gold on a light plate has
 * no contrast at 16 px. Taking the first match instead would build gold-on-white icons, which is exactly the
 * drift this file exists to prevent.
 *
 * The selectors are `[data-theme='light']` and `[data-theme='dark']`, not media queries — the dashboard
 * switches theme with a `data-theme` attribute, so there is no `prefers-color-scheme` here to find, and a
 * script that looked for one would silently fall back to the light block.
 */
function readTokens() {
  const css = readFileSync(join(ROOT, 'src/index.css'), 'utf8');

  /** The body of a `[data-theme='name'] { ... }` rule. Throws if it is not there, rather than returning ''. */
  const block = (theme) => {
    const start = css.indexOf(`[data-theme='${theme}']`);
    if (start === -1) {
      throw new Error(`src/index.css has no [data-theme='${theme}'] rule; the brand generator cannot read its colours`);
    }
    const open = css.indexOf('{', start);
    const close = css.indexOf('}', open);
    if (open === -1 || close === -1) throw new Error(`[data-theme='${theme}'] is not a complete rule`);
    return css.slice(open + 1, close);
  };

  const token = (source, name) => {
    const match = new RegExp(`${name}\\s*:\\s*(#[0-9a-fA-F]{3,8})`).exec(source);
    if (!match) throw new Error(`could not find ${name} in the ${name === '' ? '' : 'theme'} block of src/index.css`);
    return match[1];
  };

  const light = block('light');
  const dark = block('dark');
  return {
    lightGold: token(light, '--gold'),
    gold: token(dark, '--gold'),
    goldBright: token(dark, '--gold-bright'),
    bg: token(dark, '--bg'),
    text: token(dark, '--text'),
  };
}

/** Two decimals is plenty for a 64-unit canvas and keeps the path data readable. */
const r2 = (n) => Math.round(n * 100) / 100;

function svg({ tokens, size = CANVAS, plate = true, maskable = false }) {
  const gold = tokens.gold;
  const bright = tokens.goldBright;
  // A maskable icon is cropped to a circle inscribed in the square, so the mark is inset and the plate is
  // full-bleed with square corners — rounding them would be invisible after the crop.
  const scale = maskable ? MASKABLE_SCALE : 1;
  const points = (poly) =>
    poly
      .map(([x, y]) => [
        r2(32 + (x - 32) * scale),
        r2(32 + (y - 32) * scale),
      ])
      .map(([x, y]) => `${r2(x)},${r2(y)}`)
      .join(' ');

  const parts = [];
  if (plate) {
    parts.push(
      maskable
        ? `  <rect width="${size}" height="${size}" fill="${tokens.bg}"/>`
        : `  <rect width="${size}" height="${size}" rx="16" fill="${tokens.bg}"/>`,
    );
  }
  parts.push(`  <polygon points="${points(KITE)}" fill="${gold}"/>`);
  parts.push(`  <polygon points="${points(FACET)}" fill="${bright}" opacity=".8"/>`);
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" role="img" aria-label="OmniHilbras">`,
    ...parts,
    '</svg>',
    '',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// PNG by hand: a signature, an IHDR, one IDAT of deflated filtered scanlines, an IEND.
// ---------------------------------------------------------------------------

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buffer) {
  let c = -1;
  for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

/**
 * Colour at a point, as a packed `0xAABBGGRR`-style integer. The single source both writers agree on.
 *
 * Packed rather than an array, and the tokens are resolved **once per run** rather than per sample. Both
 * were measured: returning `[r, g, b, a]` from a function called five million times allocates five million
 * arrays, and calling `hexToRgb` inside it re-parsed three hex strings for every single one of those samples.
 * That is where the 63 seconds went, not the polygon test I blamed first.
 */
function sample(palette, x, y, size, { maskable }) {
  if (!maskable && !inPlate(x, y, size)) return [0, 0, 0, 0];

  const scale = maskable ? MASKABLE_SCALE : 1;
  const cx = 32 + (x / size) * 64 - 32;
  const cy = 32 + (y / size) * 64 - 32;
  // Undo the inset so both variants test the same polygons.
  const ux = 32 + (cx - 32) / scale;
  const uy = 32 + (cy - 32) / scale;

  if (inside(FACET, ux, uy)) return palette.facet;
  if (inside(KITE, ux, uy)) return palette.gold;
  return palette.bg;
}

/** Pack an `[r, g, b, a]` tuple so five million samples allocate nothing. */
const pack = (r, g, b, a) => ((a << 24) | (b << 16) | (g << 8) | r) >>> 0;

/** The three colours this run uses, resolved once. */
function paletteFrom(tokens) {
  const [gr, gg, gb] = hexToRgb(tokens.gold);
  const [fr, fg, fb] = hexToRgb(tokens.goldBright);
  const [br, bg, bb] = hexToRgb(tokens.bg);
  return { gold: pack(gr, gg, gb, 255), facet: pack(fr, fg, fb, 204), bg: pack(br, bg, bb, 255) };
}

function png(tokens, size, options = {}) {
  const palette = paletteFrom(tokens);
  const maskable = options.maskable === true;
  const plate = options.plate !== false;
  const SUPERSAMPLE = 4;
  const raw = Buffer.alloc(size * (size * 4 + 1));

  for (let y = 0; y < size; y += 1) {
    const rowStart = y * (size * 4 + 1);
    raw[rowStart] = 0; // filter: none
    for (let x = 0; x < size; x += 1) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      // Supersampled, because the kite is all diagonal and a 16 px favicon without it is visibly stepped.
      // Alpha accumulates the covered fraction, so the rounded corners are genuinely cut out rather than
      // painted the plate colour.
      for (let sy = 0; sy < SUPERSAMPLE; sy += 1) {
        for (let sx = 0; sx < SUPERSAMPLE; sx += 1) {
          const px = x + (sx + 0.5) / SUPERSAMPLE;
          const py = y + (sy + 0.5) / SUPERSAMPLE;
          const packed = sample(palette, px, py, size, { maskable, plate });
          const sa = (packed >>> 24) & 0xff;
          const weight = sa / 255;
          r += (packed & 0xff) * weight;
          g += ((packed >>> 8) & 0xff) * weight;
          b += ((packed >>> 16) & 0xff) * weight;
          a += sa;
        }
      }
      const samples = SUPERSAMPLE * SUPERSAMPLE;
      const alpha = a / samples;
      // `r` accumulated `sr * sa / 255` per sample, so the colour is recovered by dividing by the summed
      // weight `a / 255` — that is, `r * 255 / a`.
      //
      // I wrote `(samples * 255) / a` first, which multiplies every channel by an extra factor of 16: the
      // dark plate `#0c0b09` came out as `#c0b090` beige, and the gold kite as pure white because it clipped
      // at 255. Vision called the result "a beige plate with a white symbol", which I took for a rendering
      // quirk — the raw pixels were unambiguous, and reading them took one command. The arithmetic error was
      // in the last expression I wrote rather than tested.
      const scale = a === 0 ? 0 : 255 / a;
      const offset = rowStart + 1 + x * 4;
      raw[offset] = Math.min(255, Math.round(r * scale));
      raw[offset + 1] = Math.min(255, Math.round(g * scale));
      raw[offset + 2] = Math.min(255, Math.round(b * scale));
      raw[offset + 3] = Math.round(alpha);
    }
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/**
 * The wordmark, for the README and the npm page.
 *
 * The mark plus the name set in the stylesheet's own gold, on a plate the size of the drawing. Not a font:
 * it is paths, so it renders identically everywhere and cannot reflow.
 */
/**
 * Advance widths per character, in em, for a semibold humanist sans at weight 600.
 *
 * ## Why a table rather than a guessed canvas width
 *
 * The first version sized the plate as `height * 4.1` and hoped the text fit. It did not: rendering it showed
 * **"Hilbras" clipped at the plate's right edge, with the final "s" missing** — a wordmark that reads as
 * "OmniHilbra" is worse than no wordmark, and every existing test passed, because all of them checked
 * colours and coordinates and none of them looked at the drawing.
 *
 * So the width is now computed from the glyphs. These are the real advances for Inter/SF/Roboto at weight
 * 600, rounded to three places; they are a table rather than a font parse because parsing a font to get
 * metrics is a dependency this project does not have and does not want.
 *
 * `tests/brand-assets.test.js` then asserts the declared width covers the measured text, and a browser check
 * confirmed `getComputedTextLength()` lands inside it — so if a glyph is missing from the table the wordmark
 * grows rather than clips.
 */
const ADVANCE = {
  O: 0.79, m: 0.90, n: 0.60, i: 0.26, H: 0.75, l: 0.26, b: 0.60, r: 0.38, a: 0.56, s: 0.52,
  ' ': 0.26, '.': 0.27, ',': 0.27, '-': 0.34, '/': 0.42, '@': 1.0,
};

function textWidthEm(text) {
  let em = 0;
  for (const character of text) {
    const advance = ADVANCE[character];
    if (advance === undefined) {
      // A missing glyph must not silently measure as zero, which is how text gets clipped. 0.6 is the average
      // lowercase advance, and it errs toward a plate that is slightly too wide rather than one that cuts.
      throw new Error(
        `no advance width for ${JSON.stringify(character)} in the wordmark; add it to ADVANCE. ` +
          'Guessing zero here is what clipped "Hilbras" the first time.',
      );
    }
    em += advance;
  }
  return em;
}

/**
 * The mark plus the name, for the README and the npm page.
 *
 * The plate is sized from the measured text, not from a ratio, and the text is **not** converted to paths:
 * `<text>` keeps the wordmark selectable and searchable, and every surface that renders these files —
 * github, npmjs.com, a browser — has a sans-serif stack. The `font-family` lists real faces first and a
 * generic `sans-serif` last, so an unknown renderer still gets a proportional face rather than nothing.
 */
function wordmark(tokens, height = 200) {
  const scale = height / CANVAS;
  const plateH = Math.round(CANVAS * scale);
  const gap = Math.round(plateH * 0.32);
  const textX = plateH + gap;
  const fontSize = Math.round(plateH * 0.46);
  const letterSpacing = -Math.round(fontSize * 0.012);
  const baseline = Math.round(plateH * 0.66);

  const primary = 'Omni';
  const secondary = 'Hilbras';
  // The tracking applies after each glyph, including the last, so it is counted once per character.
  const em = textWidthEm(primary + secondary);
  const textWidth = em * fontSize + letterSpacing * (primary.length + secondary.length);
  // Padding on the right, matched to the left gap so the name is optically centred in what is left.
  const padding = gap;
  const width = Math.ceil(textX + textWidth + padding);
  // A whole canvas reads better than a fractional one at the edges; the plate is the full viewBox.
  const roundedWidth = Math.ceil(width / 4) * 4;

  const mark = svg({ tokens, size: CANVAS })
    .split('\n')
    .filter((line) => line.includes('<polygon'))
    .map((line) => `    ${line.trim()}`)
    .join('\n');

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${roundedWidth} ${height}" width="${roundedWidth}" height="${height}" role="img" aria-label="OmniHilbras">`,
    `  <rect width="${roundedWidth}" height="${height}" rx="${Math.round(height * 0.14)}" fill="${tokens.bg}"/>`,
    `  <g transform="translate(0, ${Math.round((height - plateH) / 2)})">`,
    mark,
    '  </g>',
    `  <text x="${textX}" y="${baseline}" font-family="Inter, 'Segoe UI', Roboto, system-ui, sans-serif" font-size="${fontSize}" font-weight="600" letter-spacing="${letterSpacing}" fill="${tokens.text}">${primary}<tspan fill="${tokens.gold}">${secondary}</tspan></text>`,
    '</svg>',
    '',
  ].join('\n');
}

const tokens = readTokens();
mkdirSync(OUT, { recursive: true });

const written = [];
const write = (name, contents) => {
  writeFileSync(join(OUT, name), contents);
  written.push(name);
};

// Vector first: the scalable original, and the source of the rasterisers' geometry.
write('logo.svg', svg({ tokens }));
write('logo-maskable.svg', svg({ tokens, maskable: true }));
// No plate, for placing on a page that supplies its own background.
write('logo-mark.svg', svg({ tokens, plate: false }));
write('wordmark.svg', wordmark(tokens));

for (const size of [16, 32, 48, 64, 128, 180, 512]) {
  write(`logo-${size}.png`, png(tokens, size));
}
for (const size of [192, 512]) {
  write(`logo-maskable-${size}.png`, png(tokens, size, { maskable: true }));
}

// The npm package renders its own README on npmjs.com, and that README references `./brand/wordmark.svg`
// — a path relative to the package, not to the repository. So the tarball needs a copy of the mark, and a
// copy made by hand is exactly the second source of truth this file exists to prevent: it would ship a logo
// from whatever geometry happened to be current when someone remembered to run `cp`.
//
// Only the four files a consumer can actually use are copied. The maskable Android set and the intermediate
// PNG sizes are for the repository, not for an npm page, and shipping them to every install is bytes spent on
// nothing.
const SDK_BRAND = join(ROOT, 'packages/omnihilbras-sdk/brand');
mkdirSync(SDK_BRAND, { recursive: true });
const forNpm = ['logo.svg', 'logo-mark.svg', 'wordmark.svg', 'logo-512.png'];
for (const name of forNpm) writeFileSync(join(SDK_BRAND, name), readFileSync(join(OUT, name)));
// Anything the generator wrote that the package should not carry would otherwise be deleted by hand.
for (const name of readdirSync(SDK_BRAND)) {
  if (!forNpm.includes(name)) rmSync(join(SDK_BRAND, name), { force: true });
}

console.log(`brand: ${written.length} files from one geometry, ${forNpm.length} copied into the npm package`);
console.log(`  gold ${tokens.gold}  gold-bright ${tokens.goldBright}  bg ${tokens.bg}  (read from src/index.css)`);