import type { Logger } from 'pino';
import type { Http2Bindings, HttpBindings } from '@hono/node-server';

import { requireMcpAuth } from '@better-auth/mcp';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';

import type { Auth } from './auth.ts';
import type { ToolServices } from './tools/register.ts';

import { registerTools } from './tools/register.ts';
import { MEDIA_SIZE_MAX_BYTES } from './whatsapp/media.ts';
import packageJson from '../package.json' with { type: 'json' };
import { renderConsentPage, renderSignInPage } from './pages.ts';
import {
  MCP_PATH,
  CONSENT_PATH,
  SIGN_IN_PATH,
  AUTH_BASE_PATH,
  WHATSAPP_SCOPE,
  RESOLVED_CLIENT_IP_HEADER
} from './auth.ts';

// send_message carries up to 10 MiB of media as base64, which takes 4 bytes for every 3, plus the rest of the call
const MCP_REQUEST_BODY_MAX_BYTES = Math.ceil(MEDIA_SIZE_MAX_BYTES / 3) * 4 + 1_024 * 1_024;

type CreateRequestHandlerParams = {
  auth: Auth;
  mcpResource: string;
  clientIpHeader: string | undefined;
  logger: Logger;
  tools: ToolServices;
};

type RequestHandler = (request: Request, bindings: HttpBindings | Http2Bindings) => Promise<Response>;

export function createRequestHandler({
  auth,
  mcpResource,
  clientIpHeader,
  logger,
  tools
}: CreateRequestHandlerParams): RequestHandler {
  const handleMcpRequest = requireMcpAuth(auth, (request) => serveMcp(request, tools), {
    resource: mcpResource,
    requiredScopes: [WHATSAPP_SCOPE]
  });

  // Returns null when the request carries no client IP: the proxy header is missing, or the peer has disconnected
  function resolveClientIp(request: Request, peerAddress: string | undefined): string | null {
    if (clientIpHeader === undefined) {
      return peerAddress ?? null;
    }
    return request.headers.get(clientIpHeader);
  }

  async function route(request: Request, pathname: string, peerAddress: string | undefined): Promise<Response> {
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
      return serveAuth({ auth, request, clientIp: resolveClientIp(request, peerAddress) });
    }
    return new Response(null, { status: 404 });
  }

  return async (request, { incoming }) => {
    const startedAt = performance.now();
    // Log the path only: query strings carry authorization codes and signed OAuth parameters
    const { pathname } = new URL(request.url);
    let response: Response;
    try {
      response = await route(request, pathname, incoming.socket.remoteAddress);
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

type ServeAuthParams = {
  auth: Auth;
  request: Request;
  clientIp: string | null;
};

async function serveAuth({ auth, request, clientIp }: ServeAuthParams): Promise<Response> {
  const headers = new Headers(request.headers);
  headers.delete(RESOLVED_CLIENT_IP_HEADER);
  if (clientIp !== null) {
    headers.set(RESOLVED_CLIENT_IP_HEADER, clientIp);
  }
  return auth.handler(new Request(request, { headers }));
}

async function serveMcp(request: Request, tools: ToolServices): Promise<Response> {
  // Stateless mode needs a server and transport per request, or JSON-RPC ids from concurrent clients collide
  const server = new McpServer({
    name: packageJson.name,
    version: packageJson.version
  });
  registerTools(server, tools);
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    maxRequestBodySize: MCP_REQUEST_BODY_MAX_BYTES
  });
  await server.connect(transport);
  // Closing the server aborts the signal of each running tool, so a client that disconnects releases its long poll
  request.signal.addEventListener('abort', () => {
    server.close().catch((error: unknown) => {
      tools.logger.warn({ err: error }, 'failed to close the MCP server of an aborted request');
    });
  });
  return transport.handleRequest(request);
}
