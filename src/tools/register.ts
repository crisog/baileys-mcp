import type { Logger } from 'pino';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import type { Store } from '../store.ts';
import type { WhatsAppConnection } from '../whatsapp/connection.ts';

import { registerReadTools } from './read.ts';
import { registerMediaTool } from './media.ts';
import { registerEventsTool } from './events.ts';
import { registerStatusTools } from './status.ts';

export type ToolServices = {
  store: Store;
  whatsapp: WhatsAppConnection;
  logger: Logger;
};

export function registerTools(server: McpServer, services: ToolServices): void {
  registerStatusTools(server, services);
  registerReadTools(server, services);
  registerEventsTool(server, services);
  registerMediaTool(server, services);
}
