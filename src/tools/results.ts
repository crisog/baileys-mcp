import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

import { z } from 'zod';

import type { Store } from '../store.ts';

export const PHONE_NUMBER_PATTERN = /^\+[1-9]\d{7,14}$/;
const CHAT_JID_PATTERN = /^(\d+@s\.whatsapp\.net|\d+@lid|[\d-]+@g\.us)$/;

export const chatRefSchema = z
  .string()
  .refine((value) => PHONE_NUMBER_PATTERN.test(value) || CHAT_JID_PATTERN.test(value), {
    message: 'Expected a phone JID, a LID JID, a group JID, or an E.164 phone number such as +5215512345678'
  })
  .describe('A chat: a phone JID, a LID JID, a group JID, or an E.164 phone number such as +5215512345678');

export const isoTimeSchema = z.iso.datetime({ offset: true }).transform((value) => new Date(value).toISOString());

type ErrorCode =
  | 'not_connected'
  | 'unknown_chat'
  | 'unknown_message'
  | 'media_too_large'
  | 'media_unavailable'
  | 'invalid_cursor'
  | 'pairing_not_allowed';

export type ToolError = {
  code: ErrorCode;
  message: string;
  retryable: boolean;
  oldest_available?: number;
  size_bytes?: number;
};

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

// Reads accept a phone number without asking WhatsApp, so it maps to the phone JID WhatsApp would use
export function chatJidsFor(store: Store, chatRef: string): string[] {
  let jid = chatRef;
  if (PHONE_NUMBER_PATTERN.test(chatRef)) {
    jid = `${chatRef.slice(1)}@s.whatsapp.net`;
  }
  return store.aliasesOf(jid);
}
