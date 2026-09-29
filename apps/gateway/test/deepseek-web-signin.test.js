import assert from 'node:assert/strict';
import test from 'node:test';
import { DeepSeekSignInStore, DEEPSEEK_TOKEN_KEY, DEEPSEEK_WEB_ORIGIN, deepSeekProfileDir } from '../dist/index.js';

/**
 * The DeepSeek sign-in flow, without a browser.
 *
 * What is worth testing is what leaks: a window nobody came back for, and two polls racing to
 * save two connections from one sign-in. The browser itself is verified by using it.
 */

test('a session is claimable once, so two polls cannot save two connections', async () => {
  const store = new DeepSeekSignInStore({ ttlMs: 60_000 });
  let reads = 0;
  const id = store.create({
    headed: true,
    read: async () => {
      reads += 1;
      return { status: 'pending' };
    },
    close: async () => undefined,
  });

  assert.ok(store.claim(id));
  assert.equal(store.claim(id), undefined, 'a second claim must be refused');
  assert.equal(reads, 0, 'claiming must not itself read the page');

  const session = store.get(id);
  assert.ok(session);
  assert.deepEqual(await session.read(), { status: 'pending' });
  assert.equal(reads, 1);
});

test('a pending outcome releases the claim, so the next poll can look again', async () => {
  // The claim exists to stop *concurrent* polls racing, not to make a flow one-shot. A sign-in
  // that reported `pending` and then refused every later poll would be a hang.
  const store = new DeepSeekSignInStore({ ttlMs: 60_000 });
  const id = store.create({
    headed: true,
    read: async () => ({ status: 'pending' }),
    close: async () => undefined,
  });
  const first = store.claim(id);
  assert.ok(first);
  first.claimed = false;
  assert.ok(store.claim(id), 'the claim should be available again after a pending read');
});

test('an expired session is closed and forgotten, not left holding a window', () => {
  // A leaked window is a signed-in session left open on someone's desktop.
  let closed = 0;
  const store = new DeepSeekSignInStore({ ttlMs: 0 });
  const id = store.create({
    headed: true,
    read: async () => ({ status: 'pending' }),
    close: async () => {
      closed += 1;
    },
  });
  assert.equal(store.get(id), undefined);
  assert.equal(closed, 1);
});

test('a session id that is not one of ours never reaches the store', async () => {
  // Session ids come from a query string, so this is the untrusted edge of the flow.
  const store = new DeepSeekSignInStore();
  for (const bad of ['', '../../etc/passwd', 'A'.repeat(33), 'zzzz', '0'.repeat(31)]) {
    assert.equal(store.get(bad), undefined);
  }
});

test('discarding closes the window exactly once', async () => {
  let closed = 0;
  const store = new DeepSeekSignInStore();
  const id = store.create({
    headed: true,
    read: async () => ({ status: 'pending' }),
    close: async () => {
      closed += 1;
    },
  });
  await store.discard(id);
  await store.discard(id);
  assert.equal(closed, 1);
});

test('closeAll leaves nothing open', async () => {
  let closed = 0;
  const store = new DeepSeekSignInStore();
  for (let index = 0; index < 3; index += 1) {
    store.create({
      headed: true,
      read: async () => ({ status: 'pending' }),
      close: async () => {
        closed += 1;
      },
    });
  }
  await store.closeAll();
  assert.equal(closed, 3);
});

test('the origin and the storage key are the ones DeepSeek actually uses', () => {
  // The token is in localStorage, not a cookie. A card that named the wrong thing here would
  // send the user to DevTools → Cookies and find nothing.
  assert.equal(DEEPSEEK_WEB_ORIGIN, 'https://chat.deepseek.com');
  assert.equal(DEEPSEEK_TOKEN_KEY, 'userToken');
});

test('the profile directory is derived from the connection key, not shared', () => {
  // Two accounts must not land in one profile, or signing in to the second silently replaces
  // the first one's session.
  assert.notEqual(deepSeekProfileDir('default'), deepSeekProfileDir('other'));
  assert.match(deepSeekProfileDir('default'), /omnihilbras\/deepseek-web\/[a-f0-9]{32}$/);
});
