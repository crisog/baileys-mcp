import type { Logger } from 'pino';
import type { WAMessage, WASocket } from '@whiskeysockets/baileys';

import { addAbortSignal } from 'node:stream';
import { downloadMediaMessage } from '@whiskeysockets/baileys';

import { statusCodeOf } from './connection.ts';

export const MEDIA_SIZE_MAX_BYTES = 10 * 1_024 * 1_024;
const MEDIA_DOWNLOAD_TIMEOUT_MS = 60_000;
const MEDIA_REUPLOAD_TIMEOUT_MS = 30_000;
// The media CDN answers 404 or 410 once it no longer holds the file
const MEDIA_EXPIRED_STATUS_CODES = [404, 410];

type MediaDownload =
  | { kind: 'downloaded'; bytes: Buffer }
  | { kind: 'too_large' }
  | { kind: 'not_connected' }
  | { kind: 'unavailable' };

type DownloadMediaParams = {
  message: WAMessage;
  getOpenSocket: () => WASocket | null;
  logger: Logger;
};

export async function downloadMedia({ message, getOpenSocket, logger }: DownloadMediaParams): Promise<MediaDownload> {
  const logFields = { message_id: message.key.id };
  try {
    return await downloadBytes(message);
  } catch (error) {
    const statusCode = statusCodeOf(error);
    const isExpired = statusCode !== null && MEDIA_EXPIRED_STATUS_CODES.includes(statusCode);
    if (!isExpired) {
      logger.warn({ err: error, ...logFields }, 'media download failed');
      return { kind: 'unavailable' };
    }
  }

  // Baileys 7.0.0-rc14 checks error.status, which its own Boom errors never set, so the server asks for the re-upload
  const socket = getOpenSocket();
  if (socket === null) {
    return { kind: 'not_connected' };
  }
  logger.info(logFields, 'requesting a media re-upload from the sender');
  let refreshed: WAMessage;
  try {
    refreshed = await withTimeout(socket.updateMediaMessage(message), MEDIA_REUPLOAD_TIMEOUT_MS);
  } catch (error) {
    logger.warn({ err: error, ...logFields }, 'media re-upload failed');
    return { kind: 'unavailable' };
  }
  try {
    return await downloadBytes(refreshed);
  } catch (error) {
    logger.warn({ err: error, ...logFields }, 'media download after re-upload failed');
    return { kind: 'unavailable' };
  }
}

async function downloadBytes(message: WAMessage): Promise<MediaDownload> {
  const deadline = AbortSignal.timeout(MEDIA_DOWNLOAD_TIMEOUT_MS);
  const stream = addAbortSignal(
    deadline,
    await withTimeout(downloadMediaMessage(message, 'stream', {}), MEDIA_DOWNLOAD_TIMEOUT_MS)
  );
  const chunks: Buffer[] = [];
  let sizeBytes = 0;
  for await (const chunk of stream) {
    if (!Buffer.isBuffer(chunk)) {
      throw new Error('The media stream yielded a value that is not a Buffer');
    }
    sizeBytes += chunk.byteLength;
    if (sizeBytes > MEDIA_SIZE_MAX_BYTES) {
      stream.destroy();
      return { kind: 'too_large' };
    }
    chunks.push(chunk);
  }
  return { kind: 'downloaded', bytes: Buffer.concat(chunks) };
}

async function withTimeout<T>(work: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`Timed out after ${timeoutMs} ms`));
    }, timeoutMs);
  });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    clearTimeout(timer);
  }
}
