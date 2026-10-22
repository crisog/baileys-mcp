import type { Logger } from 'pino';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { WASocket, WAMessage, AnyMessageContent } from '@whiskeysockets/baileys';

import { z } from 'zod';
import { randomBytes } from 'node:crypto';
import { jidNormalizedUser } from '@whiskeysockets/baileys';

import type { ToolError } from './results.ts';
import type { Message, Store } from '../store.ts';
import type { ToolServices } from './register.ts';

import { MEDIA_SIZE_MAX_BYTES } from '../whatsapp/media.ts';
import { decodeStoredMessage } from '../whatsapp/normalize.ts';
import { sendOnce, replaySend, sendOutputSchema, idempotencyKeySchema } from './ledger.ts';
import { mediaIdSchema, tooLargeError, findStoredMedia, fetchStoredMedia } from './media.ts';
import {
  toolError,
  chatJidOf,
  chatRefSchema,
  notConnectedError,
  openSocketForWrite,
  PHONE_NUMBER_PATTERN,
  messageRefInputSchema
} from './results.ts';

export const TEXT_LENGTH_MAX = 4_096;
const FILE_NAME_LENGTH_MAX = 255;
const MIME_TYPE_LENGTH_MAX = 255;
const POLL_OPTIONS_MIN = 2;
const POLL_OPTIONS_MAX = 12;
const POLL_SECRET_BYTES = 32;
// A WhatsApp group has at most 1 024 participants
const MENTIONS_MAX = 1_024;
const STICKER_MIME_TYPE = 'image/webp';
const VOICE_MIME_TYPE = 'audio/ogg; codecs=opus';
const PARTICIPANT_JID_PATTERN = /^(\d+@s\.whatsapp\.net|\d+@lid)$/;
// The content types whose WhatsApp message carries text that a mention can point into
const MENTIONABLE_TYPES: ReadonlySet<string> = new Set(['text', 'image', 'video', 'gif', 'poll']);

const mediaSourceSchema = z
  .union([
    z.strictObject({
      base64: z.base64().min(1).describe('The media bytes in base64, at most 10 MiB decoded'),
      mime_type: z.string().min(1).max(MIME_TYPE_LENGTH_MAX).describe('The MIME type, such as image/jpeg')
    }),
    z.strictObject({ media_id: mediaIdSchema })
  ])
  .describe('The media: base64 bytes with their MIME type, or the media_id of a stored message');

const captionSchema = z.string().max(TEXT_LENGTH_MAX).optional();
const optionalTextSchema = z.string().min(1).max(TEXT_LENGTH_MAX).optional();

const contentSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('text'), text: z.string().min(1).max(TEXT_LENGTH_MAX) }),
  z.strictObject({ type: z.literal('image'), media: mediaSourceSchema, caption: captionSchema }),
  z.strictObject({ type: z.literal('video'), media: mediaSourceSchema, caption: captionSchema }),
  z
    .strictObject({ type: z.literal('gif'), media: mediaSourceSchema, caption: captionSchema })
    .describe('An MP4 video that plays as a GIF'),
  z.strictObject({ type: z.literal('audio'), media: mediaSourceSchema }),
  z
    .strictObject({ type: z.literal('voice'), media: mediaSourceSchema })
    .describe(`A voice note; the media must be ${VOICE_MIME_TYPE}`),
  z.strictObject({
    type: z.literal('document'),
    media: mediaSourceSchema,
    caption: captionSchema,
    file_name: z.string().min(1).max(FILE_NAME_LENGTH_MAX).optional()
  }),
  z
    .strictObject({ type: z.literal('sticker'), media: mediaSourceSchema })
    .describe(`A sticker; the media must be ${STICKER_MIME_TYPE}`),
  z.strictObject({
    type: z.literal('location'),
    latitude: z.number().min(-90).max(90),
    longitude: z.number().min(-180).max(180),
    name: optionalTextSchema,
    address: optionalTextSchema
  }),
  z
    .strictObject({
      type: z.literal('poll'),
      question: z.string().min(1).max(TEXT_LENGTH_MAX),
      options: z
        .array(z.string().min(1).max(TEXT_LENGTH_MAX))
        .min(POLL_OPTIONS_MIN)
        .max(POLL_OPTIONS_MAX)
        .refine((options) => new Set(options).size === options.length, 'Poll options must be unique'),
      selectable_count: z
        .number()
        .int()
        .min(1)
        .default(1)
        .describe('How many options a voter may select, at most the number of options')
    })
    .refine((poll) => poll.selectable_count <= poll.options.length, {
      message: 'selectable_count cannot exceed the number of options',
      path: ['selectable_count']
    })
]);

const sendMessageInputSchema = z
  .object({
    to: chatRefSchema,
    idempotency_key: idempotencyKeySchema,
    content: contentSchema,
    reply_to: messageRefInputSchema.optional().describe('A stored message to quote'),
    mentions: z
      .array(z.string().regex(PARTICIPANT_JID_PATTERN, 'Expected a phone JID or a LID JID'))
      .min(1)
      .max(MENTIONS_MAX)
      .optional()
      .describe('Participants to mention, by phone JID or LID JID. Text and captions name them as @ and the number.')
  })
  .refine((input) => input.mentions === undefined || MENTIONABLE_TYPES.has(input.content.type), {
    message: 'Mentions apply only to text, image, video, gif, and poll content',
    path: ['mentions']
  });

type Content = z.infer<typeof contentSchema>;
type MediaContent = Extract<Content, { media: unknown }>;
type PlainContent = Exclude<Content, { media: unknown }>;
type StoredMedia = NonNullable<Message['media']>;

type MediaBytes = {
  bytes: Buffer;
  mimeType: string;
};

// What send_message knows before it needs WhatsApp
type Draft =
  | { kind: 'plain'; content: PlainContent }
  | { kind: 'media'; content: MediaContent; media: MediaBytes }
  | { kind: 'stored_media'; content: MediaContent; message: WAMessage; media: StoredMedia };

type Failure = { kind: 'error'; error: ToolError };

type Recipient = { kind: 'resolved'; jid: string } | Failure;

type MessageContent = { kind: 'ready'; content: AnyMessageContent } | Failure;

type ResolveRecipientParams = {
  socket: WASocket;
  to: string;
  logger: Logger;
};

type MessageContentParams = {
  draft: Draft;
  mentions: string[] | undefined;
  services: ToolServices;
};

export function registerSendTool(server: McpServer, services: ToolServices): void {
  const { store, whatsapp, logger } = services;
  server.registerTool(
    'send_message',
    {
      description:
        'Send a text, image, video, GIF, audio, voice note, document, sticker, location, or poll, optionally as a reply and with mentions. A repeated idempotency_key returns the first outcome and sends nothing.',
      inputSchema: sendMessageInputSchema,
      outputSchema: sendOutputSchema,
      annotations: { readOnlyHint: false }
    },
    async ({ to, idempotency_key, content, reply_to, mentions }) => {
      const replayed = replaySend(store, idempotency_key);
      if (replayed !== null) {
        return replayed;
      }

      let quoted: WAMessage | undefined;
      if (reply_to !== undefined) {
        const stored = store.findMessage({ chatJid: chatJidOf(reply_to.chat), id: reply_to.id });
        if (stored === null) {
          return toolError({
            code: 'unknown_message',
            message: `No stored message matches reply_to ${reply_to.id} in ${reply_to.chat}.`,
            retryable: false
          });
        }
        quoted = decodeStoredMessage(stored.raw);
      }
      const draft = draftOf(store, content);
      if (draft.kind === 'error') {
        return toolError(draft.error);
      }

      const writable = openSocketForWrite(whatsapp);
      if (writable.kind === 'error') {
        return toolError(writable.error);
      }
      const recipient = await resolveRecipient({ socket: writable.socket, to, logger });
      if (recipient.kind === 'error') {
        return toolError(recipient.error);
      }
      const message = await messageContentOf({ draft, mentions, services });
      if (message.kind === 'error') {
        return toolError(message.error);
      }
      return sendOnce(services, {
        tool: 'send_message',
        idempotencyKey: idempotency_key,
        jid: recipient.jid,
        content: message.content,
        quoted
      });
    }
  );
}

function draftOf(store: Store, content: Content): Draft | Failure {
  if (!('media' in content)) {
    return { kind: 'plain', content };
  }
  const source = content.media;
  if ('media_id' in source) {
    const lookup = findStoredMedia(store, source.media_id);
    if (lookup.kind === 'error') {
      return lookup;
    }
    const unsupported = unsupportedMediaError(content.type, lookup.media.mime_type);
    if (unsupported !== null) {
      return { kind: 'error', error: unsupported };
    }
    return { kind: 'stored_media', content, message: lookup.message, media: lookup.media };
  }
  const sizeBytes = Buffer.byteLength(source.base64, 'base64');
  if (sizeBytes > MEDIA_SIZE_MAX_BYTES) {
    return { kind: 'error', error: tooLargeError(sizeBytes) };
  }
  const unsupported = unsupportedMediaError(content.type, source.mime_type);
  if (unsupported !== null) {
    return { kind: 'error', error: unsupported };
  }
  return {
    kind: 'media',
    content,
    media: { bytes: Buffer.from(source.base64, 'base64'), mimeType: source.mime_type }
  };
}

// The server does not transcode, so a sticker or a voice note must arrive in the one format WhatsApp plays
function unsupportedMediaError(type: MediaContent['type'], mimeType: string): ToolError | null {
  if (type === 'sticker' && mimeType !== STICKER_MIME_TYPE) {
    return {
      code: 'unsupported_media',
      message: `A sticker must be ${STICKER_MIME_TYPE}, not ${mimeType}.`,
      retryable: false
    };
  }
  if (type === 'voice' && mimeType !== VOICE_MIME_TYPE) {
    return {
      code: 'unsupported_media',
      message: `A voice note must be ${VOICE_MIME_TYPE}, not ${mimeType}.`,
      retryable: false
    };
  }
  return null;
}

async function resolveRecipient({ socket, to, logger }: ResolveRecipientParams): Promise<Recipient> {
  if (!PHONE_NUMBER_PATTERN.test(to)) {
    return { kind: 'resolved', jid: to };
  }
  let matches: Awaited<ReturnType<WASocket['onWhatsApp']>>;
  try {
    matches = await socket.onWhatsApp(to);
  } catch (error) {
    logger.warn({ err: error }, 'failed to look up a phone number on WhatsApp');
    return { kind: 'error', error: notConnectedError };
  }
  const match = matches?.[0];
  if (match === undefined || !match.exists) {
    return {
      kind: 'error',
      error: { code: 'not_on_whatsapp', message: `${to} has no WhatsApp account.`, retryable: false }
    };
  }
  return { kind: 'resolved', jid: jidNormalizedUser(match.jid) };
}

async function messageContentOf({ draft, mentions, services }: MessageContentParams): Promise<MessageContent> {
  switch (draft.kind) {
    case 'plain':
      return { kind: 'ready', content: plainContent(draft.content, mentions) };
    case 'media':
      return { kind: 'ready', content: mediaContent(draft.content, draft.media, mentions) };
    case 'stored_media': {
      const download = await fetchStoredMedia({
        message: draft.message,
        media: draft.media,
        whatsapp: services.whatsapp,
        logger: services.logger
      });
      if (download.kind === 'error') {
        return download;
      }
      const media = { bytes: download.bytes, mimeType: draft.media.mime_type };
      return { kind: 'ready', content: mediaContent(draft.content, media, mentions) };
    }
    default: {
      const unhandled: never = draft;
      throw new Error(`Unhandled draft ${JSON.stringify(unhandled)}`);
    }
  }
}

function plainContent(content: PlainContent, mentions: string[] | undefined): AnyMessageContent {
  switch (content.type) {
    case 'text':
      return { text: content.text, mentions };
    case 'location':
      return {
        location: {
          degreesLatitude: content.latitude,
          degreesLongitude: content.longitude,
          name: content.name,
          address: content.address
        }
      };
    case 'poll':
      return {
        poll: {
          name: content.question,
          values: content.options,
          selectableCount: content.selectable_count,
          // Baileys stores the secret in the poll message, and the ingest of the sent message keeps it for votes
          messageSecret: randomBytes(POLL_SECRET_BYTES)
        },
        mentions
      };
    default: {
      const unhandled: never = content;
      throw new Error(`Unhandled content ${JSON.stringify(unhandled)}`);
    }
  }
}

function mediaContent(
  content: MediaContent,
  { bytes, mimeType }: MediaBytes,
  mentions: string[] | undefined
): AnyMessageContent {
  switch (content.type) {
    case 'image':
      return { image: bytes, mimetype: mimeType, caption: content.caption, mentions };
    case 'video':
      return { video: bytes, mimetype: mimeType, caption: content.caption, mentions };
    case 'gif':
      return { video: bytes, mimetype: mimeType, caption: content.caption, gifPlayback: true, mentions };
    case 'audio':
      return { audio: bytes, mimetype: mimeType };
    case 'voice':
      return { audio: bytes, mimetype: mimeType, ptt: true };
    case 'document':
      return { document: bytes, mimetype: mimeType, fileName: content.file_name, caption: content.caption };
    case 'sticker':
      return { sticker: bytes, mimetype: mimeType };
    default: {
      const unhandled: never = content;
      throw new Error(`Unhandled content ${JSON.stringify(unhandled)}`);
    }
  }
}
