import type { WASocket } from '@whiskeysockets/baileys';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

import { z } from 'zod';

import type { WhatsAppConnection } from '../whatsapp/connection.ts';

export const PHONE_NUMBER_PATTERN = /^\+[1-9]\d{7,14}$/;
const CHAT_JID_PATTERN = /^(\d+@s\.whatsapp\.net|\d+@lid|[\d-]+@g\.us)$/;
const MESSAGE_ID_LENGTH_MAX = 128;

export const chatRefSchema = z
  .string()
  .refine((value) => PHONE_NUMBER_PATTERN.test(value) || CHAT_JID_PATTERN.test(value), {
    message: 'Expected a phone JID, a LID JID, a group JID, or an E.164 phone number such as +5215512345678'
  })
  .describe('A chat: a phone JID, a LID JID, a group JID, or an E.164 phone number such as +5215512345678');

export const isoTimeSchema = z.iso.datetime({ offset: true }).transform((value) => new Date(value).toISOString());

export const messageRefInputSchema = z
  .object({
    chat: chatRefSchema,
    id: z.string().min(1).max(MESSAGE_ID_LENGTH_MAX).describe('The WhatsApp message id')
  })
  .describe('A stored message, by its chat and id as list_messages and pull_events report them');

type ErrorCode =
  | 'not_paired'
  | 'not_connected'
  | 'unknown_chat'
  | 'unknown_message'
  | 'not_on_whatsapp'
  | 'media_too_large'
  | 'unsupported_media'
  | 'media_unavailable'
  | 'send_in_progress'
  | 'send_ambiguous'
  | 'invalid_cursor'
  | 'pairing_not_allowed';

export type ToolError = {
  code: ErrorCode;
  message: string;
  retryable: boolean;
  oldest_available?: number;
  size_bytes?: number;
  chat?: string;
  message_id?: string;
};

export type ToolFailure = { kind: 'error'; error: ToolError };

export function toolError(error: ToolError): CallToolResult {
  return {
    isError: true,
    content: [{ type: 'text', text: JSON.stringify(error) }]
  };
}

export function toolResult(structuredContent: Record<string, unknown>): CallToolResult {
  return {
    structuredContent,
    content: [{ type: 'text', text: JSON.stringify(structuredContent) }]
  };
}

export const notConnectedError: ToolError = {
  code: 'not_connected',
  message: 'The WhatsApp connection is not open. Check get_status and retry.',
  retryable: true
};

const notPairedError: ToolError = {
  code: 'not_paired',
  message:
    'No WhatsApp account is linked, or WhatsApp logged it out. Link a phone with get_status or pair, then retry.',
  retryable: false
};

type WritableSocket = { kind: 'open'; socket: WASocket } | ToolFailure;

// A write needs a linked account and an open connection; a call refused here sends nothing
export function openSocketForWrite(whatsapp: WhatsAppConnection): WritableSocket {
  const { state, account } = whatsapp.getStatus();
  if (account === null || state === 'pairing' || state === 'logged_out') {
    return { kind: 'error', error: notPairedError };
  }
  const socket = whatsapp.getOpenSocket();
  if (socket === null) {
    return { kind: 'error', error: notConnectedError };
  }
  return { kind: 'open', socket };
}

// Only send_message asks WhatsApp to resolve a phone number; other tools map it to the phone JID WhatsApp would use
export function chatJidOf(chatRef: string): string {
  if (PHONE_NUMBER_PATTERN.test(chatRef)) {
    return `${chatRef.slice(1)}@s.whatsapp.net`;
  }
  return chatRef;
}
