import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { PNG } from 'pngjs';
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

/** Routes that must reach the dashboard SPA instead of a missing file. */
const dashboardPrefix = '/dashboard';

/** Old entry files, mapped to the route that replaced them. */
const legacyRoutes: Record<string, (search: URLSearchParams) => string> = {
  '/dashboard.html': () => '/dashboard/overview',
  '/providers.html': () => '/dashboard/providers',
  '/routing.html': () => '/dashboard/routing',
  '/provider.html': (search) => {
    const provider = search.get('provider');
    return provider ? `/dashboard/providers/${encodeURIComponent(provider)}` : '/dashboard/providers';
  },
};

function dashboardFallback(): Plugin {
  return {
    name: 'omnihilbras-dashboard-fallback',
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        const [rawPath = '', rawSearch = ''] = (request.url ?? '').split('?');
        const legacy = legacyRoutes[rawPath];
        if (legacy) {
          response.statusCode = 302;
          response.setHeader('location', legacy(new URLSearchParams(rawSearch)));
          response.end();
          return;
        }
        if (rawPath !== dashboardPrefix && !rawPath.startsWith(`${dashboardPrefix}/`)) {
          next();
          return;
        }
        // The SPA reads the real path, so only the HTML shell is rewritten.
        request.url = '/dashboard.html';
        next();
      });
    },
  };
}

/** Resolves a CSS colour to its relative luminance, or null when it carries no colour. */
function luminance(colour: string): number | null {
  const value = colour.trim().toLowerCase();
  if (value === 'none' || value === 'transparent' || value === 'currentcolor' || value === 'inherit') return null;
  if (value === 'white') return 1;
  if (value === 'black') return 0;
  if (!value.startsWith('#')) return null;
  const digits = value.slice(1);
  if (!/^[0-9a-f]+$/.test(digits)) return null;
  // `#abc` and `#abcd` are shorthands for `#aabbcc` and `#aabbccdd`. A four-digit `#ffff` is
  // white at full alpha, which is exactly how one provider's mark is written.
  const hex = digits.length === 3 || digits.length === 4 ? [...digits].map((d) => d + d).join('') : digits;
  if (hex.length !== 6 && hex.length !== 8) return null;
  const [r, g, b, a = 'ff'] = [0, 2, 4, 6].map((i) => parseInt(hex.slice(i, i + 2), 16));
  if (a === 0) return null;
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
}

/**
 * Classifies every provider logo by how dark it is, from the actual files.
 *
 * **The tile behind a logo has to be the opposite of the logo.** Seventy-two of the bundled
 * marks — `chatgpt`, `openai`, `anthropic`, `gemini`, `google`, `openrouter`, `qwen` and more —
 * are white or near-white, and twenty-five are black with no fill attribute at all. A single
 * hard-coded tile satisfies one group and hides the other, which is how ChatGPT Web and Qwen Web
 * came to render as blank white squares: a white glyph on a white tile.
 *
 * This runs at build time and reads the files, rather than keeping a hand-written list, because
 * a list is stale the moment a logo is added — and a stale entry fails *silently*, as an
 * invisible logo rather than an error. There is no app test runner to catch that, so the assets
 * themselves are the source of truth.
 *
 * A mark is called light if any of its fills is bright, not only if all of them are: NVIDIA's
 * swoosh is green-on-white, and the white half still disappears on a light tile.
 */
/**
 * The brightest a raster logo actually gets, ignoring fully transparent pixels.
 *
 * Eight of the logos the catalog uses are PNGs, and a PNG cannot be read with a regex. Sampling
 * the pixels matters for the same reason it matters for the SVGs: a logo whose brightest opaque
 * pixel is near-white needs a dark tile, and a transparent PNG left on the card surface is
 * white-on-cream in light mode and white-on-black in dark mode — readable in neither by choice.
 */
function pngBrightness(file: string): { brightest: number; average: number } | null {
  try {
    const image = PNG.sync.read(readFileSync(file));
    let brightest = 0;
    let total = 0;
    let counted = 0;
    for (let i = 0; i < image.data.length; i += 4) {
      if (image.data[i + 3]! < 16) continue;
      const value = (0.2126 * image.data[i]! + 0.7152 * image.data[i + 1]! + 0.0722 * image.data[i + 2]!) / 255;
      total += value;
      counted += 1;
      if (value > brightest) brightest = value;
    }
    if (counted === 0) return null;
    return { brightest, average: total / counted };
  } catch {
    // Unreadable file. Treated as unknown, which leaves the tile as the card surface — the
    // pre-existing behaviour, not a new failure.
    return null;
  }
}

function logoPolarity(): Plugin {
  const outputPath = join(process.cwd(), 'src', 'lib', 'logoPolarity.generated.ts');
  return {
    name: 'omnihilbras-logo-polarity',
    // Runs on `vite` and on `vite build`, so the module on disk always matches the assets.
    buildStart() {
      const directory = join(process.cwd(), 'public', 'providers');
      const light: string[] = [];
      const dark: string[] = [];
      let files: string[] = [];
      try {
        files = readdirSync(directory).filter((file) => file.endsWith('.svg') || file.endsWith('.png'));
      } catch {
        files = [];
      }
      for (const file of files) {
        if (file.endsWith('.png')) {
          const sampled = pngBrightness(join(directory, file));
          if (!sampled) continue;
          // The average, not the extremes, because a PNG's pixels fill the whole box:
          // `openai.png` is a black knot on a white field, so its brightest pixel is always 1
          // and only the average says it belongs on a dark tile. `ollama.png` is pure black,
          // which the average catches and a peak cannot.
          if (sampled.average > 0.45) light.push(file);
          else if (sampled.average < 0.25) dark.push(file);
          continue;
        }
        const source = readFileSync(join(directory, file), 'utf8');
        const fills = [...source.matchAll(/fill\s*=\s*"([^"]+)"/g)].map((match) => luminance(match[1] as string));
        const present = fills.filter((value): value is number => value !== null);
        // No fill anywhere means the SVG inherits the default, which is black.
        if (present.length === 0) {
          dark.push(file);
          continue;
        }
        // Extremes rather than an average, because an SVG's fills are sparse and an average
        // hides exactly the part that matters: `tokenharbor.svg` is a single `#16191e` path,
        // which averages to a harmless mid-tone while being invisible on a dark card. The test
        // is "no part of the mark can disappear" — any near-white fill needs a dark tile, and
        // failing that, any near-black fill needs a light one.
        if (Math.max(...present) > 0.72) light.push(file);
        else if (Math.min(...present) < 0.15) dark.push(file);
      }
      const format = (values: string[]) => `[${values.sort().map((value) => JSON.stringify(value)).join(', ')}]`;
      writeFileSync(
        outputPath,
        [
          '// GENERATED by the omnihilbras-logo-polarity plugin in vite.config.ts. Do not edit.',
          '//',
          '// Which bundled marks are light and which are dark, read from the files in',
          '// public/providers. Generated rather than hand-written because a list goes stale the',
          '// moment a logo is added, and a stale entry fails silently — an invisible logo, not an',
          '// error. There is no app test runner to catch that, so the assets are the input.',
          '',
          `const light = ${format(light)};`,
          `const dark = ${format(dark)};`,
          '',
          'const lightSet = new Set<string>(light);',
          'const darkSet = new Set<string>(dark);',
          '',
          '/** True when the asset is light and so needs a dark tile behind it to be visible. */',
          'export function needsDarkTile(file: string): boolean {',
          '  return lightSet.has(file);',
          '}',
          '',
          '/** True when the asset is dark and so needs a light tile, in light and dark mode alike. */',
          'export function needsLightTile(file: string): boolean {',
          '  return darkSet.has(file);',
          '}',
          '',
        ].join('\n'),
        'utf8',
      );
    },
  };
}

/**
 * Forwards the dashboard's `/v1` calls to the local gateway and adds the per-launch dashboard token.
 *
 * The token is read from the gateway's user-only state file on every request. That way a restarted
 * gateway, which issues a new token, is picked up without restarting Vite, and the browser never holds
 * the token. The file is read here, in the dev server, which runs as the same user.
 */
function gatewayProxy(): Plugin {
  return {
    name: 'omnihilbras-gateway-proxy',
    configureServer(server) {
      server.middlewares.use(async (request, response, next) => {
        const path = request.url ?? '';
        if (!path.startsWith('/v1/')) return next();
        const token = readDashboardTokenFile();
        const headers: Record<string, string> = {};
        for (const [name, value] of Object.entries(request.headers)) {
          if (typeof value === 'string' && name !== 'host') headers[name] = value;
        }
        headers.host = `127.0.0.1:${gatewayPort}`;
        // Only the dashboard's own page gets the token. A request that the browser marks cross-site, or that a
        // local client sends with no browser context, is forwarded as it arrived: the gateway refuses it, which is
        // the point. Attaching the token to every request made the proxy a way around the key gate.
        const fromDashboardPage = request.headers['sec-fetch-site'] === 'same-origin';
        if (fromDashboardPage && token) {
          headers.origin = `http://${request.headers.host ?? 'localhost:5173'}`;
          headers['x-omnihilbras-dashboard-token'] = token;
        }
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(chunk as Buffer);
        const body = chunks.length ? Buffer.concat(chunks) : undefined;
        try {
          const upstream = await fetch(`http://127.0.0.1:${gatewayPort}${path}`, {
            method: request.method,
            headers,
            ...(body ? { body } : {}),
            redirect: 'manual',
          });
          response.statusCode = upstream.status;
          upstream.headers.forEach((value, name) => {
            if (name !== 'content-encoding' && name !== 'transfer-encoding') response.setHeader(name, value);
          });
          response.end(Buffer.from(await upstream.arrayBuffer()));
        } catch {
          response.statusCode = 502;
          response.setHeader('content-type', 'application/json');
          response.end(JSON.stringify({ error: { code: 'PROVIDER_UNAVAILABLE', message: 'The local gateway did not answer. Start it with pnpm dev:gateway.' } }));
        }
      });
    },
  };
}

const gatewayPort = Number(process.env.OMNIHILBRAS_PORT?.trim() || 8787);

function readDashboardTokenFile(): string | undefined {
  const configHome = process.env.XDG_CONFIG_HOME?.trim();
  const path = join(configHome || join(homedir(), '.config'), 'omnihilbras', 'dashboard-token');
  try {
    return readFileSync(path, 'utf8').trim() || undefined;
  } catch {
    return undefined;
  }
}

/** The checkout's version, read once at config load so the bundle can state what it was built from. */
function readRepoVersion(): string {
  try {
    const manifest = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as { version?: unknown };
    return typeof manifest.version === 'string' ? manifest.version : 'unknown';
  } catch {
    // A build that cannot read its own manifest must still build; "unknown" is the honest answer.
    return 'unknown';
  }
}

/**
 * Serves the checkout's version as a module.
 *
 * This began as a `define`, and that does not reach a dev-served source module — the identifier
 * survived the transform untouched, so `typeof __OMNIHILBRAS_VERSION__` was guarding a variable that
 * was genuinely undefined. A virtual module is one line of resolution and behaves identically in dev
 * and in a build, which is what the drift check needs: in development the dashboard is served from
 * source while the gateway runs from `dist`, so a stale gateway is *most* likely there, and a check
 * that only worked in production would be checking the wrong case.
 */
function repoVersion(): Plugin {
  const id = 'virtual:omnihilbras-version';
  return {
    name: 'omnihilbras-repo-version',
    resolveId: (source) => (source === id ? `\0${id}` : undefined),
    load: (source) => (source === `\0${id}` ? `export const version = ${JSON.stringify(readRepoVersion())};\n` : undefined),
  };
}

/**
 * Pages that export a non-component alongside their component cannot be hot-replaced, so Vite
 * invalidates them and the screen never updates. This turns that silent no-op into a reload.
 */
const RELOAD_ON_CHANGE = [/src\/pages\/ProviderDetailPage\.tsx$/];

const fullReloadForInvalidatableModules = () => ({
  name: 'omnihilbras-full-reload',
  // `configureServer` hooks the watcher Vite already runs; `handleHotUpdate` alone only fires for modules
  // in the module graph, and an *invalidated* module has been dropped from it.
  configureServer(server: { watcher: { on: (event: string, cb: (file: string) => void) => void }; ws: { send: (payload: unknown) => void } }) {
    server.watcher.on('change', (file: string) => {
      if (RELOAD_ON_CHANGE.some((pattern) => pattern.test(file))) {
        server.ws.send({ type: 'full-reload', path: '*' });
      }
    });
  },
});

export default defineConfig({
  plugins: [
    fullReloadForInvalidatableModules(),
    dashboardFallback(), gatewayProxy(), logoPolarity(), react(), tailwindcss(), repoVersion()],
  server: {
    port: 5173,
    /**
     * Full reload for the modules Fast Refresh cannot handle.
     *
     * `ProviderDetailPage.tsx` exports a component **and** `fallbackProvider`, which the React plugin
     * refuses: "Could not Fast Refresh (\"fallbackProvider\" export is incompatible)". Vite then
     * *invalidates* the module instead of updating it, and an invalidated module never repaints — so
     * every edit to that page looked like it had not been saved. Measured: the server was serving the new
     * markup while the browser still showed the old, which cost several rounds of "refresh the page".
     *
     * A reload is a coarse answer, but it is honest: the change is visible immediately rather than
     * silently not applied.
     */
    hmr: { overlay: true },
    /**
     * The SDK's build output is a dependency of this dev server, and Vite watches it like source.
     *
     * `@hilbras/omnihilbras` resolves to `Kernel/SDK/dist`, so every SDK rebuild rewrites
     * every file there and each rewrite is a full page reload — 241 of them in one session's log. The
     * visible symptom is not "a build happened": a sign-in navigates its approval tab, and the dashboard
     * reloads underneath it, which reads as the connection having failed.
     *
     * `watch.ignored` cannot express this. It also filters *module resolution* in Vite 8, and ignoring the
     * dist directory made `@hilbras/omnihilbras` unresolvable outright ("Failed to resolve import"). So
     * the directory stays watched, and the discipline is on the person rebuilding: restart this server
     * after an SDK build rather than leaving it reloading mid-sign-in.
     */
  },
  build: {
    rollupOptions: {
      input: {
        // The marketing site and the dashboard. Every dashboard view is a route
        // inside the dashboard SPA, served under /dashboard.
        main: new URL('./index.html', import.meta.url).pathname,
        dashboard: new URL('./dashboard.html', import.meta.url).pathname,
      },
    },
  },
});
