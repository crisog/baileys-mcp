import { z } from 'zod';

const DEFAULT_PORT = 3_000;
const BETTER_AUTH_SECRET_LENGTH_MIN = 32;

const configSchema = z.object({
  PORT: z.coerce.number().int().min(1).max(65_535).default(DEFAULT_PORT),
  PUBLIC_BASE_URL: z
    .url({ protocol: /^https?$/ })
    .refine((value) => new URL(value).origin === value, 'must be an origin with no path or trailing slash'),
  DATA_DIR: z.string().min(1),
  BETTER_AUTH_SECRET: z.string().min(BETTER_AUTH_SECRET_LENGTH_MIN),
  GITHUB_CLIENT_ID: z.string().min(1),
  GITHUB_CLIENT_SECRET: z.string().min(1),
  OPERATOR_GITHUB_ID: z.coerce.number().int().positive()
});

export type Config = z.infer<typeof configSchema>;

export function parseConfig(environment: NodeJS.ProcessEnv): Config {
  const result = configSchema.safeParse(environment);
  if (!result.success) {
    throw new Error(`Invalid configuration:\n${z.prettifyError(result.error)}`);
  }
  return result.data;
}
