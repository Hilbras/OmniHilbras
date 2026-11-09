import { createServer } from 'node:http';

const port = Number(process.env.OMNIHILBRAS_PORT);
const host = process.env.OMNIHILBRAS_HOST || '127.0.0.1';
const server = createServer((request, response) => {
  if (request.url === '/health') {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end('{"status":"ok"}');
    return;
  }
  response.writeHead(404).end();
});
server.listen(port, host, () => console.log(`fake gateway ready on ${port}`));
process.on('SIGTERM', () => server.close(() => process.exit(0)));
