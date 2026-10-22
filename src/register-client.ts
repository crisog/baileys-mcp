import { pino } from 'pino';
import { parseArgs } from 'node:util';
import { serializeSignedCookie } from 'better-call';

import { parseConfig } from './config.ts';
import { openDatabase } from './database.ts';
import { createAuth, WHATSAPP_SCOPE, SIGN_IN_PATH } from './auth.ts';

const STANDARD_ERROR = 2;

const { values } = parseArgs({ options: { name: { type: 'string' } } });
if (values.name === undefined) {
  throw new Error('Usage: npm run register-client -- --name <name>');
}

// Logs go to stderr so stdout carries only the client credentials
const logger = pino(pino.destination(STANDARD_ERROR));
const config = parseConfig(process.env);
const { database } = openDatabase(config.DATA_DIR);
const auth = createAuth({ config, database, logger });
const context = await auth.$context;

const operatorAccount = await context.internalAdapter.findAccountByKey({
  providerId: 'github',
  accountId: String(config.OPERATOR_GITHUB_ID)
});
if (operatorAccount === null) {
  throw new Error(
    `The operator has not signed in yet. Sign in at ${config.PUBLIC_BASE_URL}${SIGN_IN_PATH}, then run this command again.`
  );
}

// Better Auth creates clients with client-credentials scopes only for a signed-in user, so the command signs in as the operator
const session = await context.internalAdapter.createSession(operatorAccount.userId);
try {
  const cookie = await serializeSignedCookie(context.authCookies.sessionToken.name, session.token, context.secret);
  const client = await auth.api.adminCreateOAuthClient({
    headers: new Headers({ cookie }),
    body: {
      client_name: values.name,
      grant_types: ['client_credentials'],
      client_credentials_scopes: [WHATSAPP_SCOPE],
      token_endpoint_auth_method: 'client_secret_basic'
    }
  });
  process.stdout.write(`client_id=${client.client_id}\nclient_secret=${client.client_secret}\n`);
} finally {
  await context.internalAdapter.deleteSession(session.token);
  database.close();
}
