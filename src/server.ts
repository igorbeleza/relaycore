import { createApp } from './app/create-app.js';
import { loadConfig } from './config/env.js';

const config = loadConfig();
const app = createApp(config);

async function shutdown(signal: NodeJS.Signals): Promise<void> {
  app.log.info({ signal }, 'Shutting down RelayCore');
  await app.close();
  process.exit(0);
}

process.once('SIGINT', () => void shutdown('SIGINT'));
process.once('SIGTERM', () => void shutdown('SIGTERM'));

try {
  await app.listen({ host: config.host, port: config.port });
} catch (error) {
  app.log.error(error, 'Unable to start RelayCore');
  process.exit(1);
}
