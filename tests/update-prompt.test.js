import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

/**
 * The two update questions are a flow, not two buttons.
 *
 * A person asked for: detect → ask to download → download → ask to install → install only if accepted.
 * These guards read the source of that flow because the decisions (when to ask, once per version, what a
 * decline means) are easy to break with a one-line change that still compiles and still shows a badge.
 */

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (path) => readFileSync(join(root, path), 'utf8');
const provider = read('src/components/UpdatePromptProvider.tsx');
const hook = read('src/lib/useUpdateState.ts');
const indicator = read('src/components/UpdateIndicator.tsx');
const settings = read('src/pages/SettingsPage.tsx');
const dashboard = read('src/dashboardApp.tsx');
const actions = read('src/lib/updateActions.ts');

test('the provider asks on both transitions, once per version', () => {
  assert.match(provider, /bridge\.updates\.onState\(apply\)/, 'one subscription owns both questions');
  assert.match(provider, /status === 'available'[\s\S]*ask\('download', next, true\)/, 'a found update asks to download');
  assert.match(provider, /status === 'downloaded'[\s\S]*ask\('install', next, true\)/, 'a finished download asks to install');
  assert.match(provider, /prompted\.current\.download !== next\.version/, 'a download is not asked twice for one version');
  assert.match(provider, /prompted\.current\.install !== next\.version/, 'nor is an install');
  assert.match(provider, /declined\.current\[current\.kind\] = current\.state\.version/, 'a decline is remembered for this version');
});

test('declining keeps the indicator for later and never skips a version', () => {
  assert.doesNotMatch(provider, /writeSkippedVersion/, 'a decline is not a skip');
  assert.match(provider, /clearDecline/, 'a manual button can ask again');
  assert.match(hook, /consent\.clearDecline\('download'\)/, 'the badge and Settings clear the download decline');
  assert.match(hook, /consent\.clearDecline\('install'\)/, 'and the install decline');
  assert.match(indicator, /status === 'available'[\s\S]*status === 'downloading'[\s\S]*status === 'downloaded'/, 'the badge stays visible after a decline');
});

test('a build that cannot replace itself is not asked to install', () => {
  assert.match(provider, /if \(!next\.canInstall/, 'the prompt is gated on real capability');
  assert.match(provider, /readSkippedVersion\(\)/, 'a skipped version is not asked about again');
  assert.match(provider, /status === 'idle' \|\| next\.status === 'current'/, 'prompt memory resets for the next update');
});

test('accepting an automatic question performs the action once', () => {
  assert.match(provider, /if \(accepted && current\?\.automatic\)/, 'only an automatic question runs its own action');
  assert.match(provider, /runUpdateDownload\(\)/, 'download is started after acceptance');
  assert.match(provider, /runUpdateInstall\(current\.state\)/, 'install is started after acceptance');
  assert.match(actions, /bridge\.updates\.download\(\)/, 'one bridge call for download');
  assert.match(actions, /bridge\.updates\.install\(\{ allowUnsigned: state\?\.signed === false \}\)/, 'and one for install');
  assert.match(hook, /runUpdateDownload\(\)/, 'the manual path uses the same action');
  assert.match(hook, /runUpdateInstall\(state\)/, 'and the same install decision');
});

test('the question is one accessible in-app dialog, not a native confirm', () => {
  assert.match(provider, /<Dialog open=/, 'the shared modal contract is used');
  assert.match(provider, /labelledBy=\{titleId\}/, 'the dialog has a name');
  assert.match(provider, /id=\{titleId\}/, 'and the heading carries that name');
  assert.match(provider, /Not now\s*<\/button>/, 'a decline is a real button');
  assert.match(provider, /role="note"/, 'the unsigned warning is a note, not a second question');
  // The popup's separate "stop the gateway" button keeps its own native confirm; that is not an update
  // decision. What matters is that neither update action reaches one.
  for (const [name, source] of [['provider', provider], ['hook', hook], ['settings', settings]]) {
    assert.doesNotMatch(source, /window\.confirm\(/, `${name} still uses a native confirm`);
  }
  assert.match(indicator, /void download\(\)\.catch/, 'the popup download uses the shared action');
  assert.match(indicator, /void install\(\)\.then/, 'and so does the popup install');
});

test('the dialog is mounted once, above the surfaces that can ask', () => {
  assert.equal((dashboard.match(/<UpdatePromptProvider>/g) ?? []).length, 1, 'one provider for the dashboard');
  assert.equal((dashboard.match(/<\/UpdatePromptProvider>/g) ?? []).length, 1, 'and it closes once');
  assert.match(dashboard, /<UpdatePromptProvider>[\s\S]*<DashboardShell/, 'it wraps the shell');
  assert.match(indicator, /if \(event\.key === 'Escape' && !promptOpen\)/, 'the popup leaves Escape to the topmost dialog');
});
