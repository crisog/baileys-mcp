import { pino } from 'pino';
import { join } from 'node:path';
import { serve } from '@hono/node-server';

import { createStore } from './store.ts';
import { parseConfig } from './config.ts';
import { openDatabase } from './database.ts';
import { createRequestHandler } from './http.ts';
import { createAuth, getMcpResource } from './auth.ts';
import { createWhatsAppConnection } from './whatsapp/connection.ts';

const RETENTION_INTERVAL_MS = 60 * 60 * 1_000;
const DAY_MS = 24 * 60 * 60 * 1_000;
const SEND_LEDGER_RETENTION_DAYS = 7;

const logger = pino();
const consoleLogger = logger.child({ component: 'console' });
// libsignal prints whole Signal sessions, private keys included, through the console, so only a message string passes
for (const method of ['debug', 'error', 'info', 'log', 'warn'] as const) {
  console[method] = (message: unknown): void => {
    if (typeof message === 'string') {
      consoleLogger.debug(message);
    }
  };
}
const config = parseConfig(process.env);

const { database, appliedMigrations } = openDatabase(config.DATA_DIR);
for (const migration of appliedMigrations) {
  logger.info({ migration }, 'applied migration');
}

const store = createStore(database);
const interruptedSends = store.markInterruptedSends();
if (interruptedSends > 0) {
  logger.warn({ sends: interruptedSends }, 'marked sends that the previous process left unfinished as ambiguous');
}
const whatsapp = await createWhatsAppConnection({
  authDirectory: join(config.DATA_DIR, 'whatsapp-auth'),
  store,
  logger
});

function deleteExpiredRecords(): void {
  const now = Date.now();
  const cutoff = new Date(now - config.RETENTION_DAYS * DAY_MS).toISOString();
  const sendLedgerCutoff = new Date(now - SEND_LEDGER_RETENTION_DAYS * DAY_MS).toISOString();
  const deleted = store.deleteRecordedBefore(cutoff);
  const sendsDeleted = store.deleteSendsBefore(sendLedgerCutoff);
  logger.info(
    {
      messages_deleted: deleted.messages,
      events_deleted: deleted.events,
      sends_deleted: sendsDeleted,
      cutoff,
      send_ledger_cutoff: sendLedgerCutoff
    },
    'applied retention'
  );
}
deleteExpiredRecords();
const retentionTimer = setInterval(deleteExpiredRecords, RETENTION_INTERVAL_MS);

const auth = createAuth({ config, database, logger });
const handleRequest = createRequestHandler({
  auth,
  mcpResource: getMcpResource(config.PUBLIC_BASE_URL),
  logger,
  tools: { store, whatsapp, logger }
});

const server = serve({ fetch: handleRequest, port: config.PORT }, () => {
  logger.info({ port: config.PORT, public_base_url: config.PUBLIC_BASE_URL }, 'server listening');
});
whatsapp.start();

async function shutDown(signal: NodeJS.Signals): Promise<void> {
  logger.info({ signal }, 'shutting down');
  server.close();
  clearInterval(retentionTimer);
  await whatsapp.stop();
  database.close();
  process.exit(0);
}
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.once(signal, () => {
    shutDown(signal).catch((error: unknown) => {
      logger.fatal({ err: error }, 'shutdown failed');
      process.exit(1);
    });
  });
}
