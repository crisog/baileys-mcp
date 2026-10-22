import type { Logger } from 'pino';

import { requireMcpAuth } from '@better-auth/mcp';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';

import type { Auth } from './auth.ts';

import packageJson from '../package.json' with { type: 'json' };
import { renderConsentPage, renderSignInPage } from './pages.ts';
import { MCP_PATH, CONSENT_PATH, SIGN_IN_PATH, AUTH_BASE_PATH, WHATSAPP_SCOPE } from './auth.ts';

type CreateRequestHandlerParams = {
  auth: Auth;
  mcpResource: string;
  logger: Logger;
};

type RequestHandler = (request: Request) => Promise<Response>;

export function createRequestHandler({ auth, mcpResource, logger }: CreateRequestHandlerParams): RequestHandler {
  const handleMcpRequest = requireMcpAuth(auth, serveMcp, {
    resource: mcpResource,
    requiredScopes: [WHATSAPP_SCOPE]
  });

  async function route(request: Request, pathname: string): Promise<Response> {
    if (pathname === MCP_PATH) {
      return handleMcpRequest(request);
    }
    if (pathname === SIGN_IN_PATH) {
      return renderSignInPage(request, auth);
    }
    if (pathname === CONSENT_PATH) {
      return renderConsentPage(request, auth);
    }
    // Better Auth serves its endpoints under its base path and the discovery documents under /.well-known
    if (pathname.startsWith(`${AUTH_BASE_PATH}/`) || pathname.startsWith('/.well-known/')) {
      return auth.handler(request);
    }
    return new Response(null, { status: 404 });
  }

  return async (request) => {
    const startedAt = performance.now();
    // Log the path only: query strings carry authorization codes and signed OAuth parameters
    const { pathname } = new URL(request.url);
    let response: Response;
    try {
      response = await route(request, pathname);
    } catch (error) {
      logger.error({ err: error, method: request.method, path: pathname }, 'request failed');
      return new Response(null, { status: 500 });
    }
    logger.info(
      {
        method: request.method,
        path: pathname,
        status: response.status,
        duration_ms: Math.round(performance.now() - startedAt)
      },
      'request'
    );
    return response;
  };
}

async function serveMcp(request: Request): Promise<Response> {
  // Stateless mode needs a server and transport per request, or JSON-RPC ids from concurrent clients collide
  const server = new McpServer({
    name: packageJson.name,
    version: packageJson.version
  });
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  await server.connect(transport);
  return transport.handleRequest(request);
}
