import type { Logger } from 'pino';
import type { DatabaseSync } from 'node:sqlite';

import { z } from 'zod';
import { pino } from 'pino';
import { mcp } from '@better-auth/mcp';
import { cimd } from '@better-auth/cimd';
import { betterAuth } from 'better-auth';
import { jwt } from 'better-auth/plugins';
import { fetchClientMetadataResource } from '@better-auth/cimd/node';

import type { Config } from './config.ts';

export const MCP_PATH = '/mcp';
export const AUTH_BASE_PATH = '/api/auth';
export const WHATSAPP_SCOPE = 'whatsapp';
export const SIGN_IN_PATH = '/sign-in';
export const CONSENT_PATH = '/consent';

const githubProfileSchema = z.object({ id: z.number() });

type CreateAuthParams = {
  config: Config;
  database: DatabaseSync;
  logger: Logger;
};

export type Auth = ReturnType<typeof createAuth>;

export function getMcpResource(publicBaseUrl: string): string {
  return `${publicBaseUrl}${MCP_PATH}`;
}

// oxlint-disable-next-line typescript/explicit-function-return-type -- Better Auth infers the instance type from these options
export function createAuth({ config, database, logger }: CreateAuthParams) {
  return betterAuth({
    baseURL: config.PUBLIC_BASE_URL,
    basePath: AUTH_BASE_PATH,
    secret: config.BETTER_AUTH_SECRET,
    database,
    // Better Auth enables rate limiting only when NODE_ENV is production; the plugin limits must always apply
    rateLimit: { enabled: true },
    logger: {
      log: (level, message, ...details: unknown[]) => {
        logger[level]({ component: 'better-auth', details: details.map(serializeDetail) }, message);
      }
    },
    socialProviders: {
      github: {
        clientId: config.GITHUB_CLIENT_ID,
        clientSecret: config.GITHUB_CLIENT_SECRET
      }
    },
    user: {
      // Runs before Better Auth creates a user, links an account, or signs in, so a rejection leaves no row and no session
      validateUserInfo: ({ source }) => {
        const profile = githubProfileSchema.safeParse(source.oauth?.profile);
        const isOperator =
          source.oauth?.providerId === 'github' && profile.success && profile.data.id === config.OPERATOR_GITHUB_ID;
        if (isOperator) {
          return;
        }
        logger.warn(
          { provider: source.oauth?.providerId, github_id: profile.data?.id },
          'rejected non-operator sign-in'
        );
        return {
          error: 'not_operator',
          errorDescription: 'Only the operator account can sign in.'
        };
      }
    },
    plugins: [
      jwt(),
      mcp({
        resource: getMcpResource(config.PUBLIC_BASE_URL),
        loginPage: SIGN_IN_PATH,
        consentPage: CONSENT_PATH,
        scopes: [WHATSAPP_SCOPE, 'offline_access'],
        allowDynamicClientRegistration: true,
        allowUnauthenticatedClientRegistration: true,
        // Treats a registration without application_type as native when it has a custom-scheme or loopback callback, as Cursor's does
        clientRegistrationDefaultApplicationType: 'infer',
        // The register-client command creates the client-credentials client through the admin endpoint
        clientPrivileges: ({ action }) => action === 'create' || action === 'configure-client-credentials-scopes'
      }),
      cimd({
        fetchClientMetadataResource,
        metadataProfile: 'mcp-2026-07-28'
      })
    ]
  });
}

function serializeDetail(detail: unknown): unknown {
  if (detail instanceof Error) {
    return pino.stdSerializers.err(detail);
  }
  return detail;
}
