import type { IncomingMessage, ServerResponse } from 'node:http';

import { z } from 'zod';
import { pino } from 'pino';
import { createServer } from 'node:http';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';

import packageJson from '../package.json' with { type: 'json' };

const MCP_PATH = '/mcp';
const DEFAULT_PORT = 3_000;

const environmentSchema = z.object({
  PORT: z.coerce.number().int().min(1).max(65_535).default(DEFAULT_PORT)
});

const logger = pino();
const environment = environmentSchema.parse(process.env);

async function handleMcpRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
  // Stateless mode needs a server and transport per request, or JSON-RPC ids from concurrent clients collide
  const server = new McpServer({
    name: packageJson.name,
    version: packageJson.version
  });
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  response.on('close', () => {
    server.close().catch((error: unknown) => {
      logger.error({ err: error }, 'failed to close the MCP server');
    });
  });
  await server.connect(transport);
  await transport.handleRequest(request, response);
}

const httpServer = createServer((request, response) => {
  if (request.url !== MCP_PATH) {
    response.writeHead(404).end();
    return;
  }
  handleMcpRequest(request, response).catch((error: unknown) => {
    logger.error({ err: error, method: request.method }, 'MCP request failed');
    if (!response.headersSent) {
      response.writeHead(500);
    }
    response.end();
  });
});

httpServer.listen(environment.PORT, () => {
  logger.info({ port: environment.PORT, path: MCP_PATH }, 'MCP server listening');
});
