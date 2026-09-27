import assert from 'node:assert/strict';
import test from 'node:test';
import { ChatGptWebSignInStore } from '../dist/index.js';

/**
 * The sign-in flow, without a browser.
 *
 * Signing in opens a window and waits for an account to appear, and the parts worth testing
 * are the ones that leak: a window nobody came back for, and two polls racing to save two
 * connections from one sign-in. Both are asserted here; the browser itself is verified by
 * running it.
 */

test('a session is only readable while it is open, and only once claimed', async () => {
  const store = new ChatGptWebSignInStore({ ttlMs: 60_000 });
  let reads = 0;
  const id = store.create({
    headed: true,
    read: async () => {
      reads += 1;
      return { status: 'pending' };
    },
    close: async () => undefined,
  });

  // A claim is held across one read, so a second poll arriving at the same time does not
  // also read the page — two signed-in reads would save two connections from one sign-in.
  assert.ok(store.claim(id));
  assert.equal(store.claim(id), undefined);
  assert.equal(reads, 0, 'claiming must not itself read the page');

  const session = store.get(id);
  assert.ok(session);
  assert.deepEqual(await session.read(), { status: 'pending' });
  assert.equal(reads, 1);
});

test('an expired session is closed and forgotten, not left holding a window', async () => {
  // A leaked window is a signed-in session left open on someone's desktop.
  let closed = 0;
  const store = new ChatGptWebSignInStore({ ttlMs: 0 });
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

test('a session id that is not one of ours is refused before anything is looked up', async () => {
  // Session ids come from a query string, so this is the untrusted edge of the flow. A
  // traversal-shaped value must not reach the store at all.
  const store = new ChatGptWebSignInStore();
  for (const bad of ['', '../../etc/passwd', 'A'.repeat(33), 'zzzz', '0'.repeat(31)]) {
    assert.equal(store.get(bad), undefined);
  }
});

test('discarding closes the window exactly once', async () => {
  let closed = 0;
  const store = new ChatGptWebSignInStore();
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
  const store = new ChatGptWebSignInStore();
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
