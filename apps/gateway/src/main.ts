import { startGatewayServer } from './server.js';

const instance = await startGatewayServer();
console.log(`OmniHilbras gateway listening on http://${instance.config.host}:${instance.config.port}`);

const shutdown = () => {
  instance.server.close(() => process.exit(0));
};

process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
