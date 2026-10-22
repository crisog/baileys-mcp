import type { Logger } from 'pino';
import type { WAMessage } from '@whiskeysockets/baileys';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

import { z } from 'zod';

import type { ToolServices } from './register.ts';
import type { Store, Message } from '../store.ts';
import type { ToolError, ToolFailure } from './results.ts';
import type { WhatsAppConnection } from '../whatsapp/connection.ts';

import { toolError, notConnectedError } from './results.ts';
import { downloadMedia, MEDIA_SIZE_MAX_BYTES } from '../whatsapp/media.ts';
import { decodeMediaId, decodeStoredMessage } from '../whatsapp/normalize.ts';

const MEDIA_ID_LENGTH_MAX = 1_024;

export const mediaIdSchema = z.string().min(1).max(MEDIA_ID_LENGTH_MAX).describe('The media_id of a stored message');

const downloadMediaInputSchema = z.object({ media_id: mediaIdSchema });

const downloadMediaOutputSchema = z.object({
  media_id: z.string(),
  mime_type: z.string(),
  size_bytes: z.number().int(),
  file_name: z.string().nullable()
});

type MediaBlock = CallToolResult['content'][number];

type MediaBlockParams = {
  mediaId: string;
  mimeType: string;
  data: string;
};

type StoredMediaLookup = { kind: 'found'; message: WAMessage; media: NonNullable<Message['media']> } | ToolFailure;

type FetchStoredMediaParams = {
  message: WAMessage;
  media: NonNullable<Message['media']>;
  whatsapp: WhatsAppConnection;
  logger: Logger;
};

type StoredMediaBytes = { kind: 'downloaded'; bytes: Buffer } | ToolFailure;

const unknownMedia: ToolFailure = {
  kind: 'error',
  error: { code: 'unknown_message', message: 'No stored message has this media_id.', retryable: false }
};

export function registerMediaTool(server: McpServer, { store, whatsapp, logger }: ToolServices): void {
  server.registerTool(
    'download_media',
    {
      description:
        'The media of one stored message, up to 10 MiB: an image block for images, an audio block for audio, and an embedded resource for anything else.',
      inputSchema: downloadMediaInputSchema,
      outputSchema: downloadMediaOutputSchema,
      annotations: { readOnlyHint: true }
    },
    async ({ media_id }) => {
      const lookup = findStoredMedia(store, media_id);
      if (lookup.kind === 'error') {
        return toolError(lookup.error);
      }
      const { media } = lookup;
      const download = await fetchStoredMedia({ message: lookup.message, media, whatsapp, logger });
      if (download.kind === 'error') {
        return toolError(download.error);
      }

      const result = {
        media_id,
        mime_type: media.mime_type,
        size_bytes: download.bytes.byteLength,
        file_name: media.file_name
      } satisfies z.infer<typeof downloadMediaOutputSchema>;
      return {
        structuredContent: result,
        content: [
          { type: 'text', text: JSON.stringify(result) },
          mediaBlock({ mediaId: media_id, mimeType: media.mime_type, data: download.bytes.toString('base64') })
        ]
      };
    }
  );
}

export function findStoredMedia(store: Store, mediaId: string): StoredMediaLookup {
  const key = decodeMediaId(mediaId);
  if (key === null) {
    return unknownMedia;
  }
  const stored = store.findMessage(key);
  if (stored === null) {
    return unknownMedia;
  }
  const { media } = stored.message;
  if (media === null) {
    return unknownMedia;
  }
  if (media.size_bytes !== null && media.size_bytes > MEDIA_SIZE_MAX_BYTES) {
    return { kind: 'error', error: tooLargeError(media.size_bytes) };
  }
  return {
    kind: 'found',
    message: decodeStoredMessage(stored.raw),
    media
  };
}

export async function fetchStoredMedia({
  message,
  media,
  whatsapp,
  logger
}: FetchStoredMediaParams): Promise<StoredMediaBytes> {
  const download = await downloadMedia({ message, getOpenSocket: whatsapp.getOpenSocket, logger });
  if (download.kind === 'too_large') {
    return { kind: 'error', error: tooLargeError(media.size_bytes) };
  }
  if (download.kind === 'not_connected') {
    return { kind: 'error', error: notConnectedError };
  }
  if (download.kind === 'unavailable') {
    return {
      kind: 'error',
      error: {
        code: 'media_unavailable',
        message: 'WhatsApp no longer holds this media and the sender did not upload it again.',
        retryable: false
      }
    };
  }
  return { kind: 'downloaded', bytes: download.bytes };
}

// The error omits size_bytes when the size is unknown
export function tooLargeError(sizeBytes: number | null): ToolError {
  return {
    code: 'media_too_large',
    message: `The media is larger than the ${MEDIA_SIZE_MAX_BYTES} byte limit.`,
    retryable: false,
    size_bytes: sizeBytes ?? undefined
  };
}

function mediaBlock({ mediaId, mimeType, data }: MediaBlockParams): MediaBlock {
  if (mimeType.startsWith('image/')) {
    return { type: 'image', data, mimeType };
  }
  if (mimeType.startsWith('audio/')) {
    return { type: 'audio', data, mimeType };
  }
  return {
    type: 'resource',
    resource: { uri: `whatsapp://media/${mediaId}`, mimeType, blob: data }
  };
}
