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
