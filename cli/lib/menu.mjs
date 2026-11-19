/**
 * The launcher's terminal menu — arrow-key selection and a live status header, with no dependencies.
 *
 * 9router's terminal UI is a navigable app (arrow keys, reverse-video highlight, a cached status header).
 * This brings the same feel to the bundled launcher while keeping the project's rule that the CLI has no
 * runtime dependencies: the renderer is a pure function, the selector is `readline` keypress events, and the
 * header is a few lines built from the gateway's own `/health`. The dashboard stays the management UI; this
 * is only the launcher's front door.
 *
 * `renderMenu`, `statusHeader` and `selectMenu` are separated so the drawing and the key handling can be
 * tested without a real terminal: a test drives `selectMenu` with a fake keypress stream and asserts the
 * index it resolves, and asserts the highlight in `renderMenu`'s output.
 */

import readline from 'node:readline';

const RESET = '\x1b[0m';
const REVERSE_BOLD = '\x1b[7m\x1b[1m';

/**
 * Draws the menu as a string. The selected line is reverse-video + bold when colour is on, and marked with
 * `>` when it is off (a pipe, `NO_COLOR`, or a test). Pure: no streams, no cursor moves.
 */
export function renderMenu({ title, items, selected = 0, header = '', colour = true }) {
  const lines = [];
  if (header) lines.push(header, '');
  if (title) lines.push(title, '');
  items.forEach((item, index) => {
    const isSelected = index === selected;
    const icon = isSelected ? '★' : '☆';
    const label = `${icon} ${item.label}`;
    if (isSelected && colour) lines.push(`${REVERSE_BOLD} ${label} ${RESET}`);
    else if (isSelected) lines.push(`> ${label}`);
    else lines.push(`  ${label}`);
  });
  return lines.join('\n');
}

/**
 * The status header above the menu: where the dashboard and gateway are, and the gateway's own health.
 * `health` is the gateway's reported status string (or undefined when it did not answer); nothing here is
 * invented — a gateway that is down reads as unknown, not as healthy.
 */
export function statusHeader({ dashboardUrl, gatewayUrl, health, version, update }) {
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
  return lines.join('\n');
}

/**
 * Resolves with the chosen index, or -1 for escape / Ctrl-C.
 *
 * On a TTY it renders in place and moves the highlight with the arrow keys. Off a TTY it falls back to a
 * numbered prompt, so a script or a captured run still gets a deterministic answer instead of raw escape
 * codes. `input`/`output` are injectable for tests; `setRawMode` is guarded because a fake stream has none.
 */
export function selectMenu({ items, title = '', header = '', input = process.stdin, output = process.stdout, initial = 0, colour = true, signal }) {
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
      const frame = renderMenu({ title, items, selected, header, colour });
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
      if (key.name === 'up') {
        selected = (selected - 1 + items.length) % items.length;
        render();
      } else if (key.name === 'down') {
        selected = (selected + 1) % items.length;
        render();
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
