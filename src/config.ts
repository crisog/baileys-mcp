import { z } from 'zod';

const DEFAULT_PORT = 3_000;
const BETTER_AUTH_SECRET_LENGTH_MIN = 32;
const DEFAULT_RETENTION_DAYS = 30;
const RETENTION_DAYS_MAX = 3_650;
// An HTTP field name is an RFC 9110 token
const HEADER_NAME_PATTERN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

const configSchema = z.object({
  PORT: z.coerce.number().int().min(1).max(65_535).default(DEFAULT_PORT),
  RETENTION_DAYS: z.coerce.number().int().min(1).max(RETENTION_DAYS_MAX).default(DEFAULT_RETENTION_DAYS),
  PUBLIC_BASE_URL: z
    .url({ protocol: /^https?$/ })
    .refine((value) => new URL(value).origin === value, 'must be an origin with no path or trailing slash'),
  DATA_DIR: z.string().min(1),
  BETTER_AUTH_SECRET: z.string().min(BETTER_AUTH_SECRET_LENGTH_MIN),
  GITHUB_CLIENT_ID: z.string().min(1),
  GITHUB_CLIENT_SECRET: z.string().min(1),
  OPERATOR_GITHUB_ID: z.coerce.number().int().positive(),
  CLIENT_IP_HEADER: z.string().regex(HEADER_NAME_PATTERN, 'must be an HTTP header name').optional()
});

export type Config = z.infer<typeof configSchema>;

export function parseConfig(environment: NodeJS.ProcessEnv): Config {
  const result = configSchema.safeParse(environment);
  if (!result.success) {
    throw new Error(`Invalid configuration:\n${z.prettifyError(result.error)}`);
  }
  return result.data;
}
