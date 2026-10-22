import type { WAMessage } from '@whiskeysockets/baileys';

import { z } from 'zod';
import { proto, toNumber, jidNormalizedUser } from '@whiskeysockets/baileys';

import type { Message, StoredMessageKey } from '../store.ts';

// Media without a declared type is still downloadable; clients get the generic binary type
const UNKNOWN_MIME_TYPE = 'application/octet-stream';

const mediaIdSchema = z.tuple([z.string(), z.string()]);

// Protobuf 64-bit fields arrive as a number or a Long; toNumber accepts both
type ProtoNumber = Parameters<typeof toNumber>[0];

type NormalizedContent = Pick<
  Message,
  'type' | 'text' | 'media' | 'location' | 'contacts' | 'poll' | 'reply_to' | 'mentions'
>;

type MediaFields = {
  mimetype?: string | null;
  fileLength?: ProtoNumber;
};

type MediaDetails = {
  fileName: string | null;
  durationSeconds: number | null;
  isAnimated: boolean | null;
};

export function encodeMediaId({ chatJid, id }: StoredMessageKey): string {
  return Buffer.from(JSON.stringify([chatJid, id])).toString('base64url');
}

export function decodeMediaId(mediaId: string): StoredMessageKey | null {
  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(mediaId, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  const result = mediaIdSchema.safeParse(decoded);
  if (!result.success) {
    return null;
  }
  const [chatJid, id] = result.data;
  return {
    chatJid,
    id
  };
}

export function decodeStoredMessage(raw: Uint8Array): WAMessage {
  const decoded = proto.WebMessageInfo.decode(raw);
  const { key } = decoded;
  if (!key) {
    throw new Error('A stored message has no key');
  }
  return { ...decoded, key };
}

export function toIsoTime(seconds: ProtoNumber): string {
  return new Date(toNumber(seconds) * 1_000).toISOString();
}

// The body of a text message, or the caption of media; edits replace either
export function textOf(content: proto.IMessage | null | undefined): string | null {
  if (content === null || content === undefined) {
    return null;
  }
  const candidates = [
    content.conversation,
    content.extendedTextMessage?.text,
    content.imageMessage?.caption,
    content.videoMessage?.caption,
    content.documentMessage?.caption
  ];
  for (const text of candidates) {
    if (typeof text === 'string') {
      return text;
    }
  }
  return null;
}

// Absent protobuf scalars read as their protobuf default, 0 or the empty string, as a decoded message reports them
export function normalizeContent(content: proto.IMessage, mediaId: string): NormalizedContent {
  const { reply_to, mentions } = readContext(content);
  const base = {
    text: null,
    media: null,
    location: null,
    contacts: null,
    poll: null,
    reply_to,
    mentions
  };
  if (content.conversation !== null && content.conversation !== undefined) {
    return { ...base, type: 'text', text: content.conversation };
  }
  if (content.extendedTextMessage) {
    return { ...base, type: 'text', text: content.extendedTextMessage.text ?? null };
  }
  if (content.imageMessage) {
    const image = content.imageMessage;
    return {
      ...base,
      type: 'image',
      text: image.caption ?? null,
      media: mediaOf(mediaId, image, { fileName: null, durationSeconds: null, isAnimated: null })
    };
  }
  if (content.videoMessage) {
    const video = content.videoMessage;
    let type: 'gif' | 'video' = 'video';
    if (video.gifPlayback === true) {
      type = 'gif';
    }
    return {
      ...base,
      type,
      text: video.caption ?? null,
      media: mediaOf(mediaId, video, { fileName: null, durationSeconds: video.seconds ?? null, isAnimated: null })
    };
  }
  if (content.audioMessage) {
    const audio = content.audioMessage;
    let type: 'audio' | 'voice' = 'audio';
    if (audio.ptt === true) {
      type = 'voice';
    }
    return {
      ...base,
      type,
      media: mediaOf(mediaId, audio, { fileName: null, durationSeconds: audio.seconds ?? null, isAnimated: null })
    };
  }
  if (content.documentMessage) {
    const document = content.documentMessage;
    return {
      ...base,
      type: 'document',
      text: document.caption ?? null,
      media: mediaOf(mediaId, document, {
        fileName: document.fileName ?? null,
        durationSeconds: null,
        isAnimated: null
      })
    };
  }
  if (content.stickerMessage) {
    const sticker = content.stickerMessage;
    return {
      ...base,
      type: 'sticker',
      media: mediaOf(mediaId, sticker, {
        fileName: null,
        durationSeconds: null,
        isAnimated: sticker.isAnimated ?? null
      })
    };
  }
  if (content.locationMessage) {
    const location = content.locationMessage;
    return {
      ...base,
      type: 'location',
      text: location.comment ?? null,
      location: {
        latitude: location.degreesLatitude ?? 0,
        longitude: location.degreesLongitude ?? 0,
        name: location.name ?? null,
        address: location.address ?? null
      }
    };
  }
  if (content.liveLocationMessage) {
    const location = content.liveLocationMessage;
    return {
      ...base,
      type: 'live_location',
      text: location.caption ?? null,
      location: {
        latitude: location.degreesLatitude ?? 0,
        longitude: location.degreesLongitude ?? 0,
        name: null,
        address: null
      }
    };
  }
  if (content.contactMessage) {
    return { ...base, type: 'contacts', contacts: [contactOf(content.contactMessage)] };
  }
  if (content.contactsArrayMessage) {
    const contacts = content.contactsArrayMessage.contacts ?? [];
    return { ...base, type: 'contacts', contacts: contacts.map(contactOf) };
  }
  const poll = content.pollCreationMessage ?? content.pollCreationMessageV2 ?? content.pollCreationMessageV3;
  if (poll) {
    const options: string[] = [];
    for (const option of poll.options ?? []) {
      options.push(option.optionName ?? '');
    }
    // WhatsApp sends 0 for a poll that allows every option
    let selectableCount = poll.selectableOptionsCount ?? 0;
    if (selectableCount === 0) {
      selectableCount = options.length;
    }
    return {
      ...base,
      type: 'poll',
      poll: {
        question: poll.name ?? '',
        options,
        selectable_count: selectableCount
      }
    };
  }
  return { ...base, type: 'unsupported' };
}

function mediaOf(mediaId: string, fields: MediaFields, details: MediaDetails): NonNullable<Message['media']> {
  let sizeBytes: number | null = null;
  if (fields.fileLength !== null && fields.fileLength !== undefined) {
    sizeBytes = toNumber(fields.fileLength);
  }
  let mimeType = UNKNOWN_MIME_TYPE;
  if (fields.mimetype) {
    mimeType = fields.mimetype;
  }
  return {
    media_id: mediaId,
    mime_type: mimeType,
    size_bytes: sizeBytes,
    file_name: details.fileName,
    duration_s: details.durationSeconds,
    is_animated: details.isAnimated
  };
}

function contactOf(contact: proto.Message.IContactMessage): { display_name: string; vcard: string } {
  return {
    display_name: contact.displayName ?? '',
    vcard: contact.vcard ?? ''
  };
}

function readContext(content: proto.IMessage): Pick<Message, 'reply_to' | 'mentions'> {
  const candidates = [
    content.extendedTextMessage,
    content.imageMessage,
    content.videoMessage,
    content.audioMessage,
    content.documentMessage,
    content.stickerMessage,
    content.locationMessage,
    content.liveLocationMessage,
    content.contactMessage,
    content.contactsArrayMessage,
    content.pollCreationMessage,
    content.pollCreationMessageV2,
    content.pollCreationMessageV3
  ];
  let contextInfo: proto.IContextInfo | null = null;
  for (const candidate of candidates) {
    if (candidate?.contextInfo) {
      contextInfo = candidate.contextInfo;
      break;
    }
  }
  const mentions: string[] = [];
  for (const jid of contextInfo?.mentionedJid ?? []) {
    mentions.push(jidNormalizedUser(jid));
  }
  let replyTo: Message['reply_to'] = null;
  if (contextInfo?.stanzaId) {
    let participant: string | null = null;
    if (contextInfo.participant) {
      participant = jidNormalizedUser(contextInfo.participant);
    }
    replyTo = { id: contextInfo.stanzaId, participant };
  }
  return {
    reply_to: replyTo,
    mentions
  };
}
