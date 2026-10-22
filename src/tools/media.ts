import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

import { z } from 'zod';

import type { ToolError } from './results.ts';
import type { StoredMessage } from '../store.ts';
import type { ToolServices } from './register.ts';

import { toolError, notConnectedError } from './results.ts';
import { downloadMedia, MEDIA_SIZE_MAX_BYTES } from '../whatsapp/media.ts';
import { decodeMediaId, decodeStoredMessage } from '../whatsapp/normalize.ts';

const MEDIA_ID_LENGTH_MAX = 1_024;

const downloadMediaInputSchema = z.object({
  media_id: z.string().min(1).max(MEDIA_ID_LENGTH_MAX).describe('The media_id of a stored message')
});

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
      const key = decodeMediaId(media_id);
      let stored: StoredMessage | null = null;
      if (key !== null) {
        stored = store.findMessage(key);
      }
      const media = stored?.message.media;
      if (stored === null || media === null || media === undefined) {
        return toolError({
          code: 'unknown_message',
          message: 'No stored message has this media_id.',
          retryable: false
        });
      }
      if (media.size_bytes !== null && media.size_bytes > MEDIA_SIZE_MAX_BYTES) {
        return toolError(tooLargeError(media.size_bytes));
      }

      const download = await downloadMedia({
        message: decodeStoredMessage(stored.raw),
        getOpenSocket: whatsapp.getOpenSocket,
        logger
      });
      if (download.kind === 'too_large') {
        return toolError(tooLargeError(media.size_bytes));
      }
      if (download.kind === 'not_connected') {
        return toolError(notConnectedError);
      }
      if (download.kind === 'unavailable') {
        return toolError({
          code: 'media_unavailable',
          message: 'WhatsApp no longer holds this media and the sender did not upload it again.',
          retryable: false
        });
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

// The stored size is unknown when the sender omitted it and the download passed the limit
function tooLargeError(sizeBytes: number | null): ToolError {
  const message = `The media is larger than the ${MEDIA_SIZE_MAX_BYTES} byte limit.`;
  if (sizeBytes === null) {
    return { code: 'media_too_large', message, retryable: false };
  }
  return { code: 'media_too_large', message, retryable: false, size_bytes: sizeBytes };
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
