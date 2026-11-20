/**
 * The launcher's terminal menu — a framed, navigable panel with no dependencies.
 *
 * 9router's terminal UI is a navigable app; this is the bundled launcher's front door, and it now has the
 * same affordances a person expects from one: a bordered panel, grouped actions with descriptions, a live
 * status header, and a key hint line. The renderer stays a pure function and the selector stays `readline`
 * keypress events, so both are testable without a real terminal and the CLI keeps zero runtime dependencies.
 * The dashboard remains the management UI; this only chooses where to go and whether to restart.
 *
 * `renderMenu`, `statusHeader` and `selectMenu` are separated so the drawing and the key handling can be
 * tested without a real terminal: a test drives `selectMenu` with a fake keypress stream and asserts the
 * index it resolves, and asserts the highlight in `renderMenu`'s output.
 */

import readline from 'node:readline';

const RESET = '\x1b[0m';
const REVERSE_BOLD = '\x1b[7m\x1b[1m';
const DIM = '\x1b[2m';
const BOLD = '\x1b[1m';
const CYAN = '\x1b[36m';
const BLUE = '\x1b[34m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';

const BOX = {
  topLeft: '╭', topRight: '╮', bottomLeft: '╰', bottomRight: '╯', horizontal: '─', vertical: '│', middleLeft: '├', middleRight: '┤',
};

const ANSI = /\x1b\[[0-9;]*m/g;
/** Width of the visible characters, ignoring SGR codes — CJK glyphs count as one cell, as in the launcher's summary box. */
const visibleWidth = (text) => String(text).replace(ANSI, '').length;
const paint = (code, text, colour) => (colour ? `${code}${text}${RESET}` : text);

/** Cuts a plain string to `width` cells, appending an ellipsis when it does not fit. */
function truncate(text, width) {
  const plain = String(text).replace(ANSI, '');
  if (plain.length <= width) return text;
  return width <= 1 ? '…' : `${plain.slice(0, width - 1)}…`;
}

/**
 * Draws the menu panel as a string.
 *
 * The selected line is reverse-video + bold when colour is on, and marked with `>` when it is off (a pipe,
 * `NO_COLOR`, or a test) — both shapes are pinned by tests. Items may carry a `section` heading and a short
 * `description`; sections are printed once, before the first item that declares them. A `footer` overrides
 * the default key hints. Pure: no streams, no cursor moves.
 */
export function renderMenu({ title, items, selected = 0, header = '', colour = true, footer, width }) {
  const columns = Math.max(40, Math.min(width ?? ((process.stdout.columns || 82) - 2), 120));
  const inner = columns - 4; // two spaces of padding, two border cells

  const headerLines = header ? String(header).split('\n') : [];
  // Truncate first, then measure: padding a label that was never cut would push a narrow frame wider than
  // the terminal. The description gets whatever cells remain after the marker and the aligned label.
  const maxLabel = Math.max(8, inner - 12);
  const labels = items.map((item) => truncate(item.label ?? '', maxLabel));
  const labelWidth = Math.min(maxLabel, Math.max(8, ...labels.map(visibleWidth)));
  // The widest marker is `> ★ ` plus the aligned label; leave two cells for the separator.
  const descriptionWidth = Math.max(0, inner - 4 - labelWidth - 2);
  const rows = [];
  let lastSection;
  items.forEach((item, index) => {
    if (item.section && item.section !== lastSection) {
      rows.push({ kind: 'section', text: `  ${item.section.toUpperCase()}` });
      lastSection = item.section;
    }
    const label = labels[index].padEnd(labelWidth);
    const description = item.description ? `  ${truncate(item.description, descriptionWidth)}` : '';
    rows.push({ kind: 'item', index, label, description, text: `${label}${description}` });
  });

  const hint = footer ?? (items.length <= 9
    ? '↑↓ navigate · Enter select · 1-9 quick · Esc exit'
    : '↑↓ navigate · Enter select · Esc exit');
  const content = [
    ...headerLines.map((text) => ({ kind: 'header', text })),
    { kind: 'rule' },
    ...(title ? [{ kind: 'title', text: title }] : []),
    ...rows,
    { kind: 'rule' },
    { kind: 'footer', text: hint },
  ];

  const top = `${BOX.topLeft}${BOX.horizontal.repeat(columns - 2)}${BOX.topRight}`;
  const bottom = `${BOX.bottomLeft}${BOX.horizontal.repeat(columns - 2)}${BOX.bottomRight}`;
  const divider = `${BOX.middleLeft}${BOX.horizontal.repeat(columns - 2)}${BOX.middleRight}`;
  const edge = (line) => `${paint(DIM, BOX.vertical, colour)} ${line}${' '.repeat(Math.max(0, inner - visibleWidth(line)))} ${paint(DIM, BOX.vertical, colour)}`;
  const rule = () => paint(DIM, BOX.horizontal.repeat(inner), colour);

  const lines = [paint(DIM, top, colour)];
  for (const row of content) {
    if (row.kind === 'rule') {
      lines.push(edge(rule()));
      continue;
    }
    if (row.kind === 'header') {
      // An available update is the one header line that asks for action; accent it without changing its words.
      const isUpdate = /\bUpdate\s/.test(row.text);
      lines.push(edge(paint(isUpdate ? YELLOW + BOLD : CYAN, truncate(row.text, inner), colour)));
      continue;
    }
    if (row.kind === 'title') {
      lines.push(edge(`  ${paint(BOLD, '◈', colour)} ${truncate(row.text, inner - 4)}`));
      continue;
    }
    if (row.kind === 'section') {
      lines.push(edge(paint(BLUE, truncate(row.text, inner), colour)));
      continue;
    }
    if (row.kind === 'footer') {
      lines.push(edge(paint(DIM, truncate(row.text, inner), colour)));
      continue;
    }
    const isSelected = row.index === selected;
    // The exact escape+space+star sequence is part of the renderer's contract; keep the highlighted
    // segment contiguous so a test (and a human reading a capture) can recognise it.
    const marker = isSelected
      ? (colour ? `${REVERSE_BOLD} ★ ${row.label} ${RESET}` : `> ★ ${row.label}`)
      : `  ☆ ${row.label}`;
    const description = row.description ? paint(DIM, row.description, colour) : '';
    lines.push(edge(`${marker}${description}`));
  }
  lines.push(paint(DIM, bottom, colour));
  return lines.join('\n');
}

/**
 * The status header above the menu: where the dashboard and gateway are, the gateway's own health, and
 * optional measured uptime. `health` is the gateway's reported status string (or undefined when it did not
 * answer); nothing here is invented — a gateway that is down reads as unknown, not as healthy.
 */
export function statusHeader({ dashboardUrl, gatewayUrl, health, version, update, stats }) {
  const dot = health === 'healthy' ? '●' : health ? '◐' : '○';
  const state = health ?? 'unknown';
  const build = version ? ` · ${version}` : '';
  const lines = [];
  // An available update goes first, like the reference launcher's top menu item — noticed, never auto-run.
  if (update?.updateAvailable) lines.push(`  Update     ${update.current} → ${update.latest} · run \`omnihilbras update\``);
  lines.push(
    `  Dashboard  ${dashboardUrl}`,
    `  Gateway    ${gatewayUrl}`,
    `  Status     ${dot} ${state}${build}`,
  );
  // A figure is shown only when the gateway actually reported it. "No requests" and "not measured" are
  // different claims, so an absent count stays absent rather than rendering a confident zero.
  if (stats?.requests !== undefined && Number.isFinite(stats.requests)) {
    const detail = stats.failed === undefined ? '' : ` · ${stats.failed} failed`;
    lines.push(`  Requests   ${stats.requests}${detail}${stats.unmeasured ? ' · not all metered' : ''}`);
  }
  if (stats?.uptime) lines.push(`  Uptime     ${stats.uptime}`);
  return lines.join('\n');
}

/**
 * Resolves with the chosen index, or -1 for escape / Ctrl-C.
 *
 * On a TTY it renders in place and moves the highlight with the arrow keys (j/k also work). Number keys
 * jump straight to that row. Off a TTY it falls back to a numbered prompt, so a script or a captured run
 * still gets a deterministic answer instead of raw escape codes. `input`/`output` are injectable for tests;
 * `setRawMode` is guarded because a fake stream has none.
 */
export function selectMenu({ items, title = '', header = '', input = process.stdin, output = process.stdout, initial = 0, colour = true, signal, footer }) {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve(-1);
      return;
    }
    if (!input.isTTY) {
      const rl = readline.createInterface({ input, output });
      const prompt = `${title}\n${items.map((item, index) => `  [${index + 1}] ${item.label}`).join('\n')}\n  > `;
      const onAbort = () => { rl.close(); resolve(-1); };
      signal?.addEventListener('abort', onAbort, { once: true });
      rl.question(prompt, (answer) => {
        signal?.removeEventListener('abort', onAbort);
        rl.close();
        const choice = Number(String(answer).trim());
        resolve(Number.isInteger(choice) && choice >= 1 && choice <= items.length ? choice - 1 : -1);
      });
      return;
    }

    let selected = Math.min(Math.max(initial, 0), items.length - 1);
    let lastLineCount = 0;
    const render = () => {
      const frame = renderMenu({ title, items, selected, header, colour, footer });
      if (lastLineCount > 0) output.write(`\x1b[${lastLineCount}A\x1b[0J`);
      output.write(`${frame}\n`);
      lastLineCount = frame.split('\n').length;
    };

    readline.emitKeypressEvents(input);
    if (input.setRawMode) input.setRawMode(true);
    input.resume();

    const cleanup = () => {
      input.removeListener('keypress', onKey);
      signal?.removeEventListener('abort', onAbort);
      if (input.setRawMode) input.setRawMode(false);
    };
    const onAbort = () => {
      cleanup();
      resolve(-1);
    };
    const onKey = (_str, key) => {
      if (!key) return;
      if (key.name === 'up' || key.name === 'k') {
        selected = (selected - 1 + items.length) % items.length;
        render();
      } else if (key.name === 'down' || key.name === 'j') {
        selected = (selected + 1) % items.length;
        render();
      } else if (/^[1-9]$/.test(key.name ?? '')) {
        const choice = Number(key.name) - 1;
        if (choice < items.length) {
          selected = choice;
          render();
        }
      } else if (key.name === 'return') {
        cleanup();
        resolve(selected);
      } else if (key.name === 'escape' || (key.ctrl && key.name === 'c')) {
        cleanup();
        resolve(-1);
      }
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    input.on('keypress', onKey);
    render();
  });
}
