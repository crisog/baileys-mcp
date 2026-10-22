import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import { z } from 'zod';
import { isJidGroup, jidNormalizedUser } from '@whiskeysockets/baileys';

import type { Group } from '../store.ts';
import type { ToolServices } from './register.ts';

import { messageSchema } from '../store.ts';
import { toolError, toolResult, chatJidsFor, chatRefSchema, isoTimeSchema } from './results.ts';

const CHATS_LIMIT_DEFAULT = 100;
const CHATS_LIMIT_MAX = 500;
const MESSAGES_LIMIT_DEFAULT = 50;
const MESSAGES_LIMIT_MAX = 200;

const listChatsInputSchema = z.object({
  kind: z.enum(['dm', 'group']).optional().describe('Only chats of this kind; both kinds when omitted'),
  limit: z.number().int().min(1).max(CHATS_LIMIT_MAX).default(CHATS_LIMIT_DEFAULT)
});

const listChatsOutputSchema = z.object({
  chats: z.array(
    z.object({
      jid: z.string(),
      kind: z.enum(['dm', 'group']),
      name: z.string().nullable(),
      last_message_at: z.string().nullable()
    })
  )
});

const listMessagesInputSchema = z.object({
  chat: chatRefSchema,
  since: isoTimeSchema.optional().describe('Only messages sent at or after this ISO 8601 time'),
  before: isoTimeSchema.optional().describe('Only messages sent before this ISO 8601 time'),
  limit: z.number().int().min(1).max(MESSAGES_LIMIT_MAX).default(MESSAGES_LIMIT_DEFAULT)
});

const listMessagesOutputSchema = z.object({
  messages: z.array(messageSchema),
  has_more: z.boolean()
});

export function registerReadTools(server: McpServer, { store, whatsapp, logger }: ToolServices): void {
  server.registerTool(
    'list_chats',
    {
      description:
        'Groups the account participates in and DMs with at least one stored message, most recent first. Groups come from WhatsApp while connected, otherwise from the last fetch.',
      inputSchema: listChatsInputSchema,
      outputSchema: listChatsOutputSchema,
      annotations: { readOnlyHint: true }
    },
    async ({ kind, limit }) => {
      const socket = whatsapp.getOpenSocket();
      if (socket !== null && kind !== 'dm') {
        try {
          const groups = await socket.groupFetchAllParticipating();
          const fetched: Group[] = [];
          for (const group of Object.values(groups)) {
            const jid = jidNormalizedUser(group.id);
            if (isJidGroup(jid)) {
              fetched.push({ jid, name: group.subject || null });
            }
          }
          store.replaceGroups(fetched);
        } catch (error) {
          // The stored groups still answer, as they do while disconnected
          logger.warn({ err: error }, 'failed to fetch WhatsApp groups');
        }
      }
      const result = { chats: store.listChats({ kind, limit }) } satisfies z.infer<typeof listChatsOutputSchema>;
      return toolResult(result);
    }
  );

  server.registerTool(
    'list_messages',
    {
      description:
        'Stored messages of one chat, newest first. The server stores messages from the time it started recording. Deleted messages appear with deleted_at set.',
      inputSchema: listMessagesInputSchema,
      outputSchema: listMessagesOutputSchema,
      annotations: { readOnlyHint: true }
    },
    ({ chat, since, before, limit }) => {
      const chatJids = chatJidsFor(store, chat);
      if (!store.isKnownChat(chatJids)) {
        return toolError({
          code: 'unknown_chat',
          message: `No stored message or known group matches ${chat}.`,
          retryable: false
        });
      }
      const { messages, hasMore } = store.listMessages({ chatJids, since, before, limit });
      const result = { messages, has_more: hasMore } satisfies z.infer<typeof listMessagesOutputSchema>;
      return toolResult(result);
    }
  );
}
