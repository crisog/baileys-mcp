import type { WAMessageKey } from '@whiskeysockets/baileys';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import { z } from 'zod';

import type { ToolServices } from './register.ts';

import { TEXT_LENGTH_MAX } from './send.ts';
import { decodeStoredMessage } from '../whatsapp/normalize.ts';
import { sendOnce, replaySend, sendOutputSchema, idempotencyKeySchema } from './ledger.ts';
import {
  toolError,
  chatJidOf,
  toolResult,
  chatRefSchema,
  notConnectedError,
  openSocketForWrite,
  messageRefInputSchema
} from './results.ts';

const READ_TARGETS_MAX = 100;
const TYPING_TTL_DEFAULT_S = 60;
const TYPING_TTL_MAX_S = 300;
// The longest emoji sequences, such as a family with skin tones, take about 30 UTF-16 code units
const EMOJI_LENGTH_MAX = 64;
const EMOJI_PATTERN = /^\p{RGI_Emoji}$/v;

const editMessageInputSchema = z.object({
  target: messageRefInputSchema,
  text: z.string().min(1).max(TEXT_LENGTH_MAX).describe('The new text'),
  idempotency_key: idempotencyKeySchema
});

const reactToMessageInputSchema = z.object({
  target: messageRefInputSchema,
  emoji: z
    .string()
    .max(EMOJI_LENGTH_MAX)
    .refine((value) => EMOJI_PATTERN.test(value), 'Expected exactly one emoji')
    .nullable()
    .describe("One emoji, or null to remove the account's reaction"),
  idempotency_key: idempotencyKeySchema
});

const markReadInputSchema = z.object({
  targets: z.array(messageRefInputSchema).min(1).max(READ_TARGETS_MAX)
});

const markReadOutputSchema = z.object({
  marked: z.number().int().describe('The number of messages marked read')
});

const typingStateSchema = z.enum(['composing', 'paused']);

const setTypingInputSchema = z.object({
  chat: chatRefSchema,
  state: typingStateSchema.describe('composing shows the typing indicator; paused stops it'),
  ttl_s: z
    .number()
    .int()
    .min(1)
    .max(TYPING_TTL_MAX_S)
    .default(TYPING_TTL_DEFAULT_S)
    .describe('With composing, the indicator stops after this many seconds')
});

const setTypingOutputSchema = z.object({
  chat: z.string(),
  state: typingStateSchema
});

export function registerActionTools(server: McpServer, services: ToolServices): void {
  const { store, whatsapp, logger } = services;

  server.registerTool(
    'edit_message',
    {
      description:
        'Replace the text of a stored message the account sent. A repeated idempotency_key returns the first outcome and sends nothing.',
      inputSchema: editMessageInputSchema,
      outputSchema: sendOutputSchema,
      annotations: { readOnlyHint: false }
    },
    async ({ target, text, idempotency_key }) => {
      const replayed = replaySend(store, idempotency_key);
      if (replayed !== null) {
        return replayed;
      }
      const stored = store.findMessage({ chatJid: chatJidOf(target.chat), id: target.id });
      if (stored === null || !stored.message.from_me) {
        return toolError({
          code: 'unknown_message',
          message: `No stored message that the account sent matches ${target.id} in ${target.chat}.`,
          retryable: false
        });
      }
      const writable = openSocketForWrite(whatsapp);
      if (writable.kind === 'error') {
        return toolError(writable.error);
      }
      return sendOnce(services, {
        tool: 'edit_message',
        idempotencyKey: idempotency_key,
        jid: stored.chatJid,
        content: { text, edit: decodeStoredMessage(stored.raw).key },
        quoted: undefined
      });
    }
  );

  server.registerTool(
    'react_to_message',
    {
      description:
        "Set the account's reaction on a stored message to one emoji, or remove it with null. A repeated idempotency_key returns the first outcome and sends nothing.",
      inputSchema: reactToMessageInputSchema,
      outputSchema: sendOutputSchema,
      annotations: { readOnlyHint: false, idempotentHint: true }
    },
    async ({ target, emoji, idempotency_key }) => {
      const replayed = replaySend(store, idempotency_key);
      if (replayed !== null) {
        return replayed;
      }
      const stored = store.findMessage({ chatJid: chatJidOf(target.chat), id: target.id });
      if (stored === null) {
        return toolError({
          code: 'unknown_message',
          message: `No stored message matches ${target.id} in ${target.chat}.`,
          retryable: false
        });
      }
      const writable = openSocketForWrite(whatsapp);
      if (writable.kind === 'error') {
        return toolError(writable.error);
      }
      // WhatsApp removes a reaction whose text is empty
      let reaction = '';
      if (emoji !== null) {
        reaction = emoji;
      }
      return sendOnce(services, {
        tool: 'react_to_message',
        idempotencyKey: idempotency_key,
        jid: stored.chatJid,
        content: { react: { key: decodeStoredMessage(stored.raw).key, text: reaction } },
        quoted: undefined
      });
    }
  );

  server.registerTool(
    'mark_read',
    {
      description:
        'Send read receipts for 1 to 100 stored messages. When any target is not stored, the call sends no receipt.',
      inputSchema: markReadInputSchema,
      outputSchema: markReadOutputSchema,
      annotations: { readOnlyHint: false, idempotentHint: true }
    },
    async ({ targets }) => {
      const keys: WAMessageKey[] = [];
      const unknownIds: string[] = [];
      for (const target of targets) {
        const stored = store.findMessage({ chatJid: chatJidOf(target.chat), id: target.id });
        if (stored === null) {
          unknownIds.push(target.id);
        } else {
          keys.push(decodeStoredMessage(stored.raw).key);
        }
      }
      if (unknownIds.length > 0) {
        return toolError({
          code: 'unknown_message',
          message: `No stored message matches ${unknownIds.join(', ')}. No receipt was sent.`,
          retryable: false
        });
      }
      const writable = openSocketForWrite(whatsapp);
      if (writable.kind === 'error') {
        return toolError(writable.error);
      }
      try {
        // Baileys sends no receipt for the account's own messages
        await writable.socket.readMessages(keys);
      } catch (error) {
        logger.warn({ err: error, messages: keys.length }, 'failed to send read receipts');
        return toolError(notConnectedError);
      }
      logger.info({ tool: 'mark_read', messages: keys.length }, 'sent read receipts');
      const result = { marked: keys.length } satisfies z.infer<typeof markReadOutputSchema>;
      return toolResult(result);
    }
  );

  server.registerTool(
    'set_typing',
    {
      description:
        'Show the typing indicator in a chat, refreshed every 10 s, or stop it. The indicator stops on paused, on a send to the chat, or after ttl_s.',
      inputSchema: setTypingInputSchema,
      outputSchema: setTypingOutputSchema,
      annotations: { readOnlyHint: false, idempotentHint: true }
    },
    async ({ chat, state, ttl_s }) => {
      const writable = openSocketForWrite(whatsapp);
      if (writable.kind === 'error') {
        return toolError(writable.error);
      }
      const chatJid = chatJidOf(chat);
      const outcome = await whatsapp.setTyping({ chatJid, presence: state, ttlMs: ttl_s * 1_000 });
      if (outcome.kind === 'not_connected') {
        return toolError(notConnectedError);
      }
      const result = { chat: store.resolveJid(chatJid), state } satisfies z.infer<typeof setTypingOutputSchema>;
      return toolResult(result);
    }
  );
}
