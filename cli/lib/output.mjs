/**
 * Printing.
 *
 * Two rules, both learned from what a CLI is actually used for: **`--json` must be the whole answer**, so
 * a script never parses a table; and **colour is for people**, so it disappears the moment stdout is not
 * a terminal. The old project's output had no JSON mode on most commands and coloured unconditionally.
 */

const codes = {
  dim: '\x1b[2m',
  bold: '\x1b[1m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  off: '\x1b[0m',
};

export function createOutput({ json = false, stream = process.stdout } = {}) {
  const colour = Boolean(stream.isTTY) && !json && !process.env.NO_COLOR;
  const paint = (code, text) => (colour ? `${code}${text}${codes.off}` : text);

  return {
    json,
    /** The answer, as data. Printed last and alone when `--json` was asked for. */
    data(value) {
      if (json) stream.write(`${JSON.stringify(value, null, 2)}\n`);
      return value;
    },
    /**
     * One JSON object on one line — the only honest shape for a stream.
     *
     * `data()` pretty-prints, which is right for a complete answer and wrong for `logs --json`: a follower
     * never finishes, and a multi-line record per event is not the newline-delimited JSON a `jq`/`while read`
     * consumer expects. Nothing is printed when `--json` was not asked for.
     */
    ndjson(value) {
      if (json) stream.write(`${JSON.stringify(value)}\n`);
      return value;
    },
    line(text = '') {
      if (!json) stream.write(`${text}\n`);
    },
    title(text) {
      if (!json) stream.write(`${paint(codes.bold, text)}\n`);
    },
    muted(text) {
      return paint(codes.dim, text);
    },
    ok(text) {
      return paint(codes.green, text);
    },
    warn(text) {
      return paint(codes.yellow, text);
    },
    bad(text) {
      return paint(codes.red, text);
    },
    /**
     * A table with a header rule, sized to its widest cell.
     *
     * Hand-rolled rather than taken from a package: it is thirty lines, and the old project's own
     * comment on its spinner — "no external dependency for twelve frames" — applies here for the same
     * reason. The CLI has no dependencies at all, which is what keeps the trust surface the same size as
     * the launcher's.
     */
    /**
     * A framed card for a small set of labelled facts, matching the launcher menu's visual language.
     * Additive: commands that print plain lines keep working, and `--json` still prints nothing here.
     */
    box(title, rows) {
      if (json) return;
      const clean = (text) => String(text).replace(/\x1b\[[0-9;]*m/g, '');
      const lines = [title, ...rows.filter((row) => row !== undefined)];
      const width = Math.max(...lines.map((line) => clean(line).length));
      const glyph = colour
        ? { tl: '╭', tr: '╮', bl: '╰', br: '╯', h: '─', v: '│' }
        : { tl: '+', tr: '+', bl: '+', br: '+', h: '-', v: '|' };
      const edge = `${glyph.tl}${glyph.h.repeat(width + 2)}${glyph.tr}`;
      stream.write(`${edge}\n`);
      lines.forEach((line, index) => {
        const pad = ' '.repeat(Math.max(0, width - clean(line).length));
        stream.write(`${glyph.v} ${line}${pad} ${glyph.v}\n`);
        if (index === 0 && rows.length) stream.write(`${glyph.v}${' '.repeat(width + 2)}${glyph.v}\n`);
      });
      stream.write(`${glyph.bl}${glyph.h.repeat(width + 2)}${glyph.br}\n`);
    },

    table(rows, headers) {
      if (json) return;
      if (rows.length === 0) {
        stream.write(`${paint(codes.dim, 'Nothing to show.')}\n`);
        return;
      }
      const widths = headers.map((header, index) => Math.max(header.length, ...rows.map((row) => String(row[index] ?? '').length)));
      const render = (cells) => cells.map((cell, index) => String(cell ?? '').padEnd(widths[index])).join('  ').trimEnd();
      stream.write(`${paint(codes.bold, render(headers))}\n`);
      stream.write(`${paint(codes.dim, widths.map((width) => '─'.repeat(width)).join('  '))}\n`);
      for (const row of rows) stream.write(`${render(row)}\n`);
    },
  };
}
