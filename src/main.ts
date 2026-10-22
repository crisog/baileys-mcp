import { pino } from 'pino';
import { serve } from '@hono/node-server';

import { parseConfig } from './config.ts';
import { openDatabase } from './database.ts';
import { createRequestHandler } from './http.ts';
import { createAuth, getMcpResource } from './auth.ts';

const logger = pino();
const config = parseConfig(process.env);

const { database, appliedMigrations } = openDatabase(config.DATA_DIR);
for (const migration of appliedMigrations) {
  logger.info({ migration }, 'applied migration');
}

const auth = createAuth({ config, database, logger });
const handleRequest = createRequestHandler({
  auth,
  mcpResource: getMcpResource(config.PUBLIC_BASE_URL),
  logger
});

serve({ fetch: handleRequest, port: config.PORT }, () => {
  logger.info({ port: config.PORT, public_base_url: config.PUBLIC_BASE_URL }, 'server listening');
});
