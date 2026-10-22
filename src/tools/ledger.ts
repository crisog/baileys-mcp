import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { WAMessage, AnyMessageContent } from '@whiskeysockets/baileys';

import { z } from 'zod';
import { generateMessageIDV2 } from '@whiskeysockets/baileys';

import type { ToolError } from './results.ts';
import type { ToolServices } from './register.ts';
import type { Store, SendTool, SendRecord } from '../store.ts';

import { maskJid } from '../whatsapp/ingest.ts';
import { toolError, toolResult, notConnectedError } from './results.ts';

const IDEMPOTENCY_KEY_LENGTH_MAX = 256;

export const idempotencyKeySchema = z
  .string()
  .min(1)
  .max(IDEMPOTENCY_KEY_LENGTH_MAX)
  .describe(
    'A key the client chooses for this send, such as a UUID. A repeated call with the same key returns the first outcome and sends nothing.'
  );

export const sendOutputSchema = z.object({
  status: z
    .enum(['sent', 'ambiguous'])
    .describe(
      'ambiguous: the send did not finish within 60 s. The server will not send it again; a receipt event for message_id confirms delivery.'
    ),
  chat: z.string(),
  message_id: z.string().describe('The id of the WhatsApp message the server sent')
});

type SendResult = z.infer<typeof sendOutputSchema>;

type SentMessage = Pick<SendRecord, 'chatJid' | 'messageId'>;

type SendOnceParams = {
  tool: SendTool;
  idempotencyKey: string;
  jid: string;
  content: AnyMessageContent;
  quoted: WAMessage | undefined;
};

// The outcome of an earlier call with this key, or null when the ledger has no entry for it
export function replaySend(store: Store, idempotencyKey: string): CallToolResult | null {
  const record = store.findSend(idempotencyKey);
  if (record === null) {
    return null;
  }
  return replay(store, record);
}

// Records the key and the chosen message id before Baileys sees the message, so a key reaches WhatsApp at most once
export async function sendOnce(
  { store, whatsapp, logger }: ToolServices,
  { tool, idempotencyKey, jid, content, quoted }: SendOnceParams
): Promise<CallToolResult> {
  const sent: SentMessage = {
    chatJid: jid,
    messageId: generateMessageIDV2(whatsapp.getStatus().account?.phone_jid)
  };
  if (!store.reserveSend({ idempotencyKey, tool, ...sent })) {
    // A concurrent call with the same key reserved it while this one prepared its message
    const record = store.findSend(idempotencyKey);
    if (record === null) {
      throw new Error('The send ledger refused a key it holds no entry for');
    }
    return replay(store, record);
  }

  const startedAt = performance.now();
  const outcome = await whatsapp.send({ jid, messageId: sent.messageId, content, quoted });
  const logFields = {
    tool,
    message_id: sent.messageId,
    chat: maskJid(jid),
    outcome: outcome.kind,
    duration_ms: Math.round(performance.now() - startedAt)
  };
  switch (outcome.kind) {
    case 'not_connected':
      store.releaseSend(idempotencyKey);
      logger.info(logFields, 'send');
      return toolError(notConnectedError);
    case 'sent':
      store.finishSend({ idempotencyKey, outcome: 'sent' });
      logger.info(logFields, 'send');
      return toolResult(resultOf(store, sent, 'sent'));
    case 'timed_out':
      store.finishSend({ idempotencyKey, outcome: 'ambiguous' });
      logger.warn(logFields, 'send');
      return toolResult(resultOf(store, sent, 'ambiguous'));
    case 'failed':
      // Baileys can fail after the message left the socket, so a failure is as uncertain as a timeout
      store.finishSend({ idempotencyKey, outcome: 'ambiguous' });
      logger.warn({ ...logFields, err: outcome.error }, 'send');
      return toolError(
        ambiguousError(
          store,
          sent,
          `WhatsApp rejected or interrupted the send (${describeError(outcome.error)}). It may or may not have reached WhatsApp. The server will not send it again with this idempotency key; a receipt event for message_id confirms delivery.`
        )
      );
    default: {
      const unhandled: never = outcome;
      throw new Error(`Unhandled send outcome ${JSON.stringify(unhandled)}`);
    }
  }
}

function replay(store: Store, record: SendRecord): CallToolResult {
  switch (record.outcome) {
    case 'sending':
      return toolError({
        code: 'send_in_progress',
        message: 'A send with this idempotency key is in progress. Retry the call for its outcome.',
        retryable: true
      });
    case 'sent':
      return toolResult(resultOf(store, record, 'sent'));
    case 'ambiguous':
      if (store.hasReceipt(record.messageId)) {
        return toolResult(resultOf(store, record, 'sent'));
      }
      return toolError(
        ambiguousError(
          store,
          record,
          'The send with this idempotency key did not finish, and no receipt for it has arrived. It may or may not have reached WhatsApp. The server will not send it again; a receipt event for message_id confirms delivery.'
        )
      );
    default: {
      const unhandled: never = record.outcome;
      throw new Error(`Unhandled send ledger outcome ${JSON.stringify(unhandled)}`);
    }
  }
}

function resultOf(store: Store, { chatJid, messageId }: SentMessage, status: SendResult['status']): SendResult {
  return {
    status,
    chat: store.resolveJid(chatJid),
    message_id: messageId
  };
}

function ambiguousError(store: Store, { chatJid, messageId }: SentMessage, message: string): ToolError {
  return {
    code: 'send_ambiguous',
    message,
    retryable: false,
    chat: store.resolveJid(chatJid),
    message_id: messageId
  };
}

function describeError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}
