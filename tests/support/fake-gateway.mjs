import { createServer } from 'node:http';

const port = Number(process.env.OMNIHILBRAS_PORT);
const host = process.env.OMNIHILBRAS_HOST || '127.0.0.1';

/**
 * The crash clock starts on the first `/health` answer, not when this process is spawned.
 *
 * It used to start at module load, and the supervisor's readiness poll is 50 ms. On a loaded machine the child
 * was still binding when its timer fired, so `start()` threw *"The gateway exited before it became ready"* before
 * the supervisor could walk into its restart limit — `desktop-supervisor.test.js` failed inside `pnpm verify`
 * while passing on its own. Arming the timer on the listen callback is still a race, because `start()` is only
 * satisfied by a `/health` **200**, and a loaded machine can take longer than the crash delay to answer one. So the
 * timer is armed by the one event that readiness actually requires: a fixture that measures "crash after N ms"
 * from anything other than having answered is measuring the test machine.
 */
const crashAfter = Number(process.env.FAKE_CRASH_AFTER_MS);
let armed = false;
function armCrashClock() {
  if (armed || !(crashAfter > 0)) return;
  armed = true;
  setTimeout(() => process.exit(1), crashAfter);
}

const server = createServer((request, response) => {
  if (request.url === '/health') {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end('{"status":"ok"}');
    armCrashClock();
    return;
  }
  response.writeHead(404).end();
});
server.listen(port, host, () => console.log(`fake gateway ready on ${port}`));
process.on('SIGTERM', () => server.close(() => process.exit(0)));
