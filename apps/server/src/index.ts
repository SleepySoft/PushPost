import { buildServer } from './app.js';

let closing = false;
try {
  const app = await buildServer();
  const close = async (signal: string): Promise<void> => {
    if (closing) return;
    closing = true;
    app.log.info({ signal }, 'Shutting down');
    await app.close();
  };
  process.once('SIGINT', () => void close('SIGINT'));
  process.once('SIGTERM', () => void close('SIGTERM'));
  await app.listen({ port: app.pushpost.config.port, host: app.pushpost.config.host });
  app.log.info({ host: app.pushpost.config.host, port: app.pushpost.config.port }, 'PushPost server started');
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`PushPost server failed to start: ${message}\n`);
  process.exitCode = 1;
}
