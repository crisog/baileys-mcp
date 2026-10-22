import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import { z } from 'zod';

import type { ToolServices } from './register.ts';
import type { PairRequest } from '../whatsapp/connection.ts';

import { CONNECTION_STATES } from '../store.ts';
import { pairingSchema, connectionStatusSchema } from '../whatsapp/connection.ts';
import { toolError, toolResult, notConnectedError, PHONE_NUMBER_PATTERN } from './results.ts';

const getStatusOutputSchema = connectionStatusSchema.extend({
  events_head: z.number().int().describe('The newest event cursor; pull_events with after set to it starts from now')
});

const pairInputSchema = z
  .object({
    method: z.enum(['qr', 'code']),
    phone_number: z
      .string()
      .regex(PHONE_NUMBER_PATTERN)
      .optional()
      .describe('The E.164 number of the phone to link, such as +5215512345678. Required for method code.')
  })
  .superRefine((input, context) => {
    if (input.method === 'code' && input.phone_number === undefined) {
      context.addIssue({ code: 'custom', path: ['phone_number'], message: 'Method code requires phone_number' });
    }
    if (input.method === 'qr' && input.phone_number !== undefined) {
      context.addIssue({ code: 'custom', path: ['phone_number'], message: 'Method qr takes no phone_number' });
    }
  });

const pairOutputSchema = z.object({
  state: z.enum(CONNECTION_STATES),
  pairing: pairingSchema
});

export function registerStatusTools(server: McpServer, { store, whatsapp }: ToolServices): void {
  server.registerTool(
    'get_status',
    {
      description:
        'Connection state, the linked account, the last disconnect, the pairing QR or code while pairing, and the newest event cursor.',
      inputSchema: z.object({}),
      outputSchema: getStatusOutputSchema,
      annotations: { readOnlyHint: true }
    },
    () => {
      const status = {
        ...whatsapp.getStatus(),
        events_head: store.eventsHead()
      } satisfies z.infer<typeof getStatusOutputSchema>;
      return toolResult(status);
    }
  );

  server.registerTool(
    'pair',
    {
      description:
        'Link a phone. Method qr restarts QR pairing and returns the QR string; method code returns a code to enter on the phone. Refused while a linked account is connected or reconnecting.',
      inputSchema: pairInputSchema,
      outputSchema: pairOutputSchema,
      annotations: { readOnlyHint: false }
    },
    async ({ method, phone_number }) => {
      let request: PairRequest = { method: 'qr' };
      if (method === 'code') {
        if (phone_number === undefined) {
          throw new Error('The pair input schema requires phone_number for method code');
        }
        request = { method: 'code', phoneNumber: phone_number.slice(1) };
      }
      const outcome = await whatsapp.pair(request);
      if (outcome.kind === 'not_allowed') {
        return toolError({ code: 'pairing_not_allowed', message: outcome.message, retryable: false });
      }
      if (outcome.kind === 'not_connected') {
        return toolError(notConnectedError);
      }
      const result = { state: outcome.state, pairing: outcome.pairing } satisfies z.infer<typeof pairOutputSchema>;
      return toolResult(result);
    }
  );
}
