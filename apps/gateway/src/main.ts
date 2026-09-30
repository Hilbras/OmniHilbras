import { startGatewayServer } from './server.js';

const instance = await startGatewayServer();
console.log(`OmniHilbras gateway listening on http://${instance.config.host}:${instance.config.port}`);

const shutdown = () => {
  // The server stops accepting first, then the service drains. That order is the contract: the
  // key store's drain loops until nothing is in flight, which terminates on an idle queue and not
  // on a busy one, so it must not run while requests are still arriving.
  instance.server.close(() => {
    void instance.service.close().then(() => process.exit(0));
  });
};

process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
