import type { DatabaseSync } from 'node:sqlite';

import { z } from 'zod';
import { isLidUser } from '@whiskeysockets/baileys';

export const CONNECTION_STATES = [
  'pairing',
  'connecting',
  'open',
  'reconnecting',
  'replaced',
  'logged_out',
  'closed'
] as const;
export type ConnectionState = (typeof CONNECTION_STATES)[number];

export const EVENT_TYPES = [
  'message',
  'message_edited',
  'message_deleted',
  'reaction',
  'receipt',
  'poll_vote',
  'identity_mapped',
  'connection'
] as const;
type EventType = (typeof EVENT_TYPES)[number];

const MESSAGE_TYPES = [
  'text',
  'image',
  'video',
  'gif',
  'audio',
  'voice',
  'document',
  'sticker',
  'location',
  'live_location',
  'contacts',
  'poll',
  'unsupported'
] as const;

const participantSchema = z.object({
  jid: z.string(),
  phone_jid: z.string().nullable(),
  lid_jid: z.string().nullable(),
  name: z.string().nullable()
});
export type Participant = z.infer<typeof participantSchema>;

const RECEIPT_STATES = ['server_ack', 'delivered', 'read', 'played'] as const;
export type ReceiptState = (typeof RECEIPT_STATES)[number];

const messageRefSchema = z.object({
  chat: z.string(),
  id: z.string()
});
type MessageRef = z.infer<typeof messageRefSchema>;

export const messageSchema = z.object({
  chat: z.string(),
  chat_kind: z.enum(['dm', 'group']),
  id: z.string(),
  from_me: z.boolean(),
  sender: participantSchema,
  timestamp: z.string(),
  type: z.enum(MESSAGE_TYPES),
  text: z.string().nullable(),
  media: z
    .object({
      media_id: z.string(),
      mime_type: z.string(),
      size_bytes: z.number().int().nullable(),
      file_name: z.string().nullable(),
      duration_s: z.number().int().nullable(),
      is_animated: z.boolean().nullable()
    })
    .nullable(),
  location: z
    .object({
      latitude: z.number(),
      longitude: z.number(),
      name: z.string().nullable(),
      address: z.string().nullable()
    })
    .nullable(),
  contacts: z.array(z.object({ display_name: z.string(), vcard: z.string() })).nullable(),
  poll: z
    .object({
      question: z.string(),
      options: z.array(z.string()),
      selectable_count: z.number().int()
    })
    .nullable(),
  reply_to: z.object({ id: z.string(), participant: z.string().nullable() }).nullable(),
  mentions: z.array(z.string()),
  edited_at: z.string().nullable(),
  deleted_at: z.string().nullable()
});
export type Message = z.infer<typeof messageSchema>;

export const lastDisconnectSchema = z.object({
  code: z.number().int().nullable(),
  at: z.string()
});
export type LastDisconnect = z.infer<typeof lastDisconnectSchema>;

const eventBase = {
  cursor: z.number().int(),
  at: z.string()
};

export const eventSchema = z.discriminatedUnion('type', [
  z.object({ ...eventBase, type: z.literal('message'), message: messageSchema }),
  z.object({
    ...eventBase,
    type: z.literal('message_edited'),
    ref: messageRefSchema,
    text: z.string(),
    by: participantSchema,
    edited_at: z.string()
  }),
  z.object({
    ...eventBase,
    type: z.literal('message_deleted'),
    ref: messageRefSchema,
    by: participantSchema,
    deleted_at: z.string()
  }),
  z.object({
    ...eventBase,
    type: z.literal('reaction'),
    target: messageRefSchema,
    reactor: participantSchema,
    emoji: z.string().nullable()
  }),
  z.object({
    ...eventBase,
    type: z.literal('receipt'),
    target: messageRefSchema,
    participant: participantSchema.nullable(),
    state: z.enum(RECEIPT_STATES)
  }),
  z.object({
    ...eventBase,
    type: z.literal('poll_vote'),
    poll: messageRefSchema,
    voter: participantSchema,
    selected_options: z.array(z.string())
  }),
  z.object({ ...eventBase, type: z.literal('identity_mapped'), lid_jid: z.string(), phone_jid: z.string() }),
  z.object({
    ...eventBase,
    type: z.literal('connection'),
    state: z.enum(CONNECTION_STATES),
    last_disconnect: lastDisconnectSchema.nullable()
  })
]);
type Event = z.infer<typeof eventSchema>;

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
type EventBody = DistributiveOmit<Event, 'cursor' | 'at'>;

const LEDGER_OUTCOMES = ['sending', 'sent', 'ambiguous'] as const;

const storedMessageRowSchema = z.object({
  chat_jid: z.string(),
  message: z.string(),
  raw: z.instanceof(Uint8Array),
  message_secret: z.instanceof(Uint8Array).nullable()
});
const messageRowSchema = z.object({ message: z.string() });
const eventRowSchema = z.object({
  cursor: z.number().int(),
  at: z.string(),
  payload: z.string()
});
const eventPayloadSchema = z.record(z.string(), z.unknown());
export const chatSchema = z.object({
  jid: z.string(),
  kind: z.enum(['dm', 'group']),
  name: z.string().nullable(),
  last_message_at: z.string().nullable()
});
const jidRowSchema = z.object({ jid: z.string() });
const nameRowSchema = z.object({ name: z.string().nullable() });
const cursorRowSchema = z.object({ cursor: z.number().int().nullable() });
const integerRowSchema = z.object({ value: z.number().int() });
const sendRowSchema = z.object({
  chat_jid: z.string(),
  message_id: z.string(),
  outcome: z.enum(LEDGER_OUTCOMES)
});

type StoredMessage = {
  chatJid: string;
  message: Message;
  raw: Uint8Array;
  messageSecret: Uint8Array | null;
};

export type StoredMessageKey = {
  chatJid: string;
  id: string;
};

type Chat = z.infer<typeof chatSchema>;

export type Group = {
  jid: string;
  name: string | null;
};

type IdentityPair = {
  lidJid: string;
  phoneJid: string;
};

type RecordEventParams = {
  body: EventBody;
  chatJid: string | null;
  factKey: string | null;
};

type RecordEditParams = {
  chatJid: string;
  factKey: string;
  targetId: string;
  text: string;
  by: Participant;
  editedAt: string;
};

type RecordDeleteParams = {
  chatJid: string;
  factKey: string;
  targetId: string;
  by: Participant;
  deletedAt: string;
};

type ListChatsParams = {
  kind: 'dm' | 'group' | undefined;
  limit: number;
};

type ListMessagesParams = {
  chatJids: string[];
  since: string | undefined;
  before: string | undefined;
  limit: number;
};

type ListedMessages = {
  messages: Message[];
  hasMore: boolean;
};

type ReadEventsParams = {
  after: number;
  since: string | undefined;
  types: EventType[] | undefined;
  chatJids: string[] | undefined;
  limit: number;
};

export type ReadEvents = {
  events: Event[];
  next: number;
  hasMore: boolean;
};

type WaitForEventParams = {
  timeoutMs: number;
  signal: AbortSignal;
};

type DeletedCounts = {
  messages: number;
  events: number;
};

export type SendTool = 'send_message' | 'edit_message' | 'react_to_message';

export type SendRecord = {
  chatJid: string;
  messageId: string;
  outcome: (typeof LEDGER_OUTCOMES)[number];
};

type ReserveSendParams = {
  idempotencyKey: string;
  tool: SendTool;
  chatJid: string;
  messageId: string;
};

type FinishSendParams = {
  idempotencyKey: string;
  outcome: 'sent' | 'ambiguous';
};

export interface Store {
  recordMessage(params: StoredMessage): void;
  recordEvent(params: RecordEventParams): void;
  recordEdit(params: RecordEditParams): void;
  recordDelete(params: RecordDeleteParams): void;
  learnIdentity(pair: IdentityPair): void;
  findMessage(key: StoredMessageKey): StoredMessage | null;
  aliasesOf(jid: string): string[];
  participantFor(jid: string, name: string | null): Participant;
  resolveJid(jid: string): string;
  replaceGroups(groups: Group[]): void;
  isKnownChat(chatJids: string[]): boolean;
  listChats(params: ListChatsParams): Chat[];
  listMessages(params: ListMessagesParams): ListedMessages;
  readEvents(params: ReadEventsParams): ReadEvents;
  eventsHead(): number;
  oldestAvailableCursor(): number;
  cursorBefore(at: string): number;
  waitForEvent(params: WaitForEventParams): Promise<void>;
  deleteRecordedBefore(cutoff: string): DeletedCounts;
  findSend(idempotencyKey: string): SendRecord | null;
  reserveSend(params: ReserveSendParams): boolean;
  finishSend(params: FinishSendParams): void;
  releaseSend(idempotencyKey: string): void;
  markInterruptedSends(): number;
  hasReceipt(messageId: string): boolean;
  deleteSendsBefore(cutoff: string): number;
}

export function createStore(database: DatabaseSync): Store {
  const waiters = new Set<() => void>();

  function inTransaction(work: () => boolean): void {
    database.exec('BEGIN IMMEDIATE');
    let hasNewEvent: boolean;
    try {
      hasNewEvent = work();
      database.exec('COMMIT');
    } catch (error) {
      database.exec('ROLLBACK');
      throw error;
    }
    if (hasNewEvent) {
      for (const wake of waiters) {
        wake();
      }
    }
  }

  // Returns true when the event is new; a repeated fact_key records nothing
  function insertEvent({ body, chatJid, factKey }: RecordEventParams): boolean {
    // An INSERT that ON CONFLICT skips still takes an AUTOINCREMENT value, which would leave a gap in the cursors
    if (factKey !== null && hasEvent(factKey)) {
      return false;
    }
    database
      .prepare(
        'INSERT INTO events (at, type, chat_jid, fact_key, payload) VALUES (:at, :type, :chat_jid, :fact_key, :payload)'
      )
      .run({
        at: new Date().toISOString(),
        type: body.type,
        chat_jid: chatJid,
        fact_key: factKey,
        payload: JSON.stringify(body)
      });
    return true;
  }

  function hasEvent(factKey: string): boolean {
    const row = database.prepare('SELECT EXISTS (SELECT 1 FROM events WHERE fact_key = ?) AS value').get(factKey);
    return integerRowSchema.parse(row).value === 1;
  }

  function findPhoneForLid(lidJid: string): string | null {
    const row = database.prepare('SELECT phone_jid AS jid FROM lid_map WHERE lid_jid = ?').get(lidJid);
    if (row === undefined) {
      return null;
    }
    return jidRowSchema.parse(row).jid;
  }

  function findLidForPhone(phoneJid: string): string | null {
    const row = database
      .prepare('SELECT lid_jid AS jid FROM lid_map WHERE phone_jid = ? ORDER BY rowid DESC LIMIT 1')
      .get(phoneJid);
    if (row === undefined) {
      return null;
    }
    return jidRowSchema.parse(row).jid;
  }

  function participantFor(jid: string, name: string | null): Participant {
    if (isLidUser(jid)) {
      const phoneJid = findPhoneForLid(jid);
      return {
        jid: phoneJid ?? jid,
        phone_jid: phoneJid,
        lid_jid: jid,
        name
      };
    }
    return {
      jid,
      phone_jid: jid,
      lid_jid: findLidForPhone(jid),
      name
    };
  }

  function resolveJid(jid: string): string {
    if (!isLidUser(jid)) {
      return jid;
    }
    return findPhoneForLid(jid) ?? jid;
  }

  function aliasesOf(jid: string): string[] {
    let alias: string | null;
    if (isLidUser(jid)) {
      alias = findPhoneForLid(jid);
    } else {
      alias = findLidForPhone(jid);
    }
    if (alias === null) {
      return [jid];
    }
    return [jid, alias];
  }

  // Stored records keep the identities known when they were recorded; reads apply mappings learned since
  function refreshParticipant(participant: Participant): Participant {
    if (participant.phone_jid !== null && participant.lid_jid !== null) {
      return participant;
    }
    return participantFor(participant.jid, participant.name);
  }

  function refreshRef(ref: MessageRef): MessageRef {
    return { ...ref, chat: resolveJid(ref.chat) };
  }

  function refreshMessage(message: Message): Message {
    let replyTo = message.reply_to;
    if (replyTo !== null && replyTo.participant !== null) {
      replyTo = { ...replyTo, participant: resolveJid(replyTo.participant) };
    }
    return {
      ...message,
      chat: resolveJid(message.chat),
      sender: refreshParticipant(message.sender),
      reply_to: replyTo,
      mentions: message.mentions.map(resolveJid)
    };
  }

  function refreshEvent(event: Event): Event {
    switch (event.type) {
      case 'message':
        return { ...event, message: refreshMessage(event.message) };
      case 'message_edited':
        return { ...event, ref: refreshRef(event.ref), by: refreshParticipant(event.by) };
      case 'message_deleted':
        return { ...event, ref: refreshRef(event.ref), by: refreshParticipant(event.by) };
      case 'reaction':
        return { ...event, target: refreshRef(event.target), reactor: refreshParticipant(event.reactor) };
      case 'receipt': {
        let participant = event.participant;
        if (participant !== null) {
          participant = refreshParticipant(participant);
        }
        return { ...event, target: refreshRef(event.target), participant };
      }
      case 'poll_vote':
        return { ...event, poll: refreshRef(event.poll), voter: refreshParticipant(event.voter) };
      case 'identity_mapped':
        return event;
      case 'connection':
        return event;
      default: {
        const unhandled: never = event;
        throw new Error(`Unhandled event type ${JSON.stringify(unhandled)}`);
      }
    }
  }

  function parseMessageJson(json: string): Message {
    return refreshMessage(messageSchema.parse(JSON.parse(json)));
  }

  function readCursor(sql: string, ...parameters: string[]): number | null {
    return cursorRowSchema.parse(database.prepare(sql).get(...parameters)).cursor;
  }

  // AUTOINCREMENT keeps the highest cursor ever issued, so the head survives retention deleting every event
  function eventsHead(): number {
    const row = database
      .prepare("SELECT coalesce(max(seq), 0) AS value FROM sqlite_sequence WHERE name = 'events'")
      .get();
    return integerRowSchema.parse(row).value;
  }

  return {
    recordMessage({ chatJid, message, raw, messageSecret }) {
      inTransaction(() => {
        // Baileys can deliver one message under the phone JID and again under the LID of the same chat
        const stored = database
          .prepare(
            `SELECT EXISTS (
               SELECT 1 FROM messages WHERE chat_jid IN (SELECT value FROM json_each(:chat_jids)) AND id = :id
             ) AS value`
          )
          .get({ chat_jids: JSON.stringify(aliasesOf(chatJid)), id: message.id });
        if (integerRowSchema.parse(stored).value === 1) {
          return false;
        }
        database
          .prepare(
            `INSERT INTO messages (chat_jid, id, timestamp, recorded_at, message, raw, message_secret)
             VALUES (:chat_jid, :id, :timestamp, :recorded_at, :message, :raw, :message_secret)`
          )
          .run({
            chat_jid: chatJid,
            id: message.id,
            timestamp: message.timestamp,
            recorded_at: new Date().toISOString(),
            message: JSON.stringify(message),
            raw,
            message_secret: messageSecret
          });
        return insertEvent({
          body: { type: 'message', message },
          chatJid,
          factKey: `message:${chatJid}:${message.id}`
        });
      });
    },

    recordEvent(params) {
      inTransaction(() => insertEvent(params));
    },

    recordEdit({ chatJid, factKey, targetId, text, by, editedAt }) {
      inTransaction(() => {
        const isNew = insertEvent({
          body: { type: 'message_edited', ref: { chat: chatJid, id: targetId }, text, by, edited_at: editedAt },
          chatJid,
          factKey
        });
        if (isNew) {
          database
            .prepare(
              `UPDATE messages SET message = json_set(message, '$.text', :text, '$.edited_at', :edited_at)
               WHERE chat_jid IN (SELECT value FROM json_each(:chat_jids)) AND id = :id`
            )
            .run({
              text,
              edited_at: editedAt,
              chat_jids: JSON.stringify(aliasesOf(chatJid)),
              id: targetId
            });
        }
        return isNew;
      });
    },

    recordDelete({ chatJid, factKey, targetId, by, deletedAt }) {
      inTransaction(() => {
        const isNew = insertEvent({
          body: { type: 'message_deleted', ref: { chat: chatJid, id: targetId }, by, deleted_at: deletedAt },
          chatJid,
          factKey
        });
        if (isNew) {
          database
            .prepare(
              `UPDATE messages SET message = json_set(message, '$.deleted_at', :deleted_at)
               WHERE chat_jid IN (SELECT value FROM json_each(:chat_jids)) AND id = :id`
            )
            .run({
              deleted_at: deletedAt,
              chat_jids: JSON.stringify(aliasesOf(chatJid)),
              id: targetId
            });
        }
        return isNew;
      });
    },

    learnIdentity({ lidJid, phoneJid }) {
      inTransaction(() => {
        const result = database
          .prepare(
            `INSERT INTO lid_map (lid_jid, phone_jid) VALUES (:lid_jid, :phone_jid)
             ON CONFLICT (lid_jid) DO UPDATE SET phone_jid = excluded.phone_jid WHERE phone_jid <> excluded.phone_jid`
          )
          .run({ lid_jid: lidJid, phone_jid: phoneJid });
        if (Number(result.changes) === 0) {
          return false;
        }
        return insertEvent({
          body: { type: 'identity_mapped', lid_jid: lidJid, phone_jid: phoneJid },
          chatJid: null,
          factKey: null
        });
      });
    },

    findMessage({ chatJid, id }) {
      const row = database
        .prepare(
          `SELECT chat_jid, message, raw, message_secret FROM messages
           WHERE chat_jid IN (SELECT value FROM json_each(:chat_jids)) AND id = :id`
        )
        .get({ chat_jids: JSON.stringify(aliasesOf(chatJid)), id });
      if (row === undefined) {
        return null;
      }
      const stored = storedMessageRowSchema.parse(row);
      return {
        chatJid: stored.chat_jid,
        message: parseMessageJson(stored.message),
        raw: stored.raw,
        messageSecret: stored.message_secret
      };
    },

    aliasesOf,
    participantFor,
    resolveJid,

    replaceGroups(groups) {
      inTransaction(() => {
        database.exec('DELETE FROM groups');
        const insert = database.prepare('INSERT INTO groups (jid, name) VALUES (:jid, :name)');
        for (const group of groups) {
          insert.run({ jid: group.jid, name: group.name });
        }
        return false;
      });
    },

    isKnownChat(chatJids) {
      const row = database
        .prepare(
          `SELECT (SELECT count(*) FROM groups WHERE jid IN (SELECT value FROM json_each(:chat_jids)))
                + (SELECT count(*) FROM messages WHERE chat_jid IN (SELECT value FROM json_each(:chat_jids))) AS value`
        )
        .get({ chat_jids: JSON.stringify(chatJids) });
      return integerRowSchema.parse(row).value > 0;
    },

    listChats({ kind, limit }) {
      const rows = database
        .prepare(
          `SELECT jid, kind, name, last_message_at FROM (
             SELECT groups.jid, 'group' AS kind, groups.name,
               (SELECT max(timestamp) FROM messages WHERE messages.chat_jid = groups.jid) AS last_message_at
             FROM groups
             UNION ALL
             SELECT coalesce(lid_map.phone_jid, messages.chat_jid) AS jid, 'dm' AS kind, NULL AS name,
               max(messages.timestamp) AS last_message_at
             FROM messages LEFT JOIN lid_map ON lid_map.lid_jid = messages.chat_jid
             WHERE messages.chat_jid NOT LIKE '%@g.us'
             GROUP BY 1
           )
           WHERE :kind IS NULL OR kind = :kind
           ORDER BY last_message_at IS NULL, last_message_at DESC
           LIMIT :limit`
        )
        .all({ kind: kind ?? null, limit });
      const chats: Chat[] = [];
      for (const row of rows) {
        const chat = chatSchema.parse(row);
        if (chat.kind === 'dm') {
          // A DM's name is the latest push name the other participant sent
          const nameRow = database
            .prepare(
              `SELECT json_extract(message, '$.sender.name') AS name FROM messages
               WHERE chat_jid IN (SELECT value FROM json_each(:chat_jids)) AND json_extract(message, '$.from_me') = 0
               ORDER BY timestamp DESC LIMIT 1`
            )
            .get({ chat_jids: JSON.stringify(aliasesOf(chat.jid)) });
          if (nameRow !== undefined) {
            chat.name = nameRowSchema.parse(nameRow).name;
          }
        }
        chats.push(chat);
      }
      return chats;
    },

    listMessages({ chatJids, since, before, limit }) {
      const rows = database
        .prepare(
          `SELECT message FROM messages
           WHERE chat_jid IN (SELECT value FROM json_each(:chat_jids))
             AND (:since IS NULL OR timestamp >= :since)
             AND (:before IS NULL OR timestamp < :before)
           ORDER BY timestamp DESC, recorded_at DESC
           LIMIT :limit`
        )
        .all({
          chat_jids: JSON.stringify(chatJids),
          since: since ?? null,
          before: before ?? null,
          limit: limit + 1
        });
      const messages: Message[] = [];
      for (const row of rows.slice(0, limit)) {
        messages.push(parseMessageJson(messageRowSchema.parse(row).message));
      }
      return {
        messages,
        hasMore: rows.length > limit
      };
    },

    readEvents({ after, since, types, chatJids, limit }) {
      let typesJson: string | null = null;
      if (types !== undefined) {
        typesJson = JSON.stringify(types);
      }
      let chatJidsJson: string | null = null;
      if (chatJids !== undefined) {
        chatJidsJson = JSON.stringify(chatJids);
      }
      // node:sqlite is synchronous, so the head and the page come from the same database state
      const head = eventsHead();
      const rows = database
        .prepare(
          `SELECT cursor, at, payload FROM events
           WHERE cursor > :after
             AND (:since IS NULL OR at >= :since)
             AND (:types IS NULL OR type IN (SELECT value FROM json_each(:types)))
             AND (:chat_jids IS NULL OR chat_jid IN (SELECT value FROM json_each(:chat_jids)))
           ORDER BY cursor
           LIMIT :limit`
        )
        .all({
          after,
          since: since ?? null,
          types: typesJson,
          chat_jids: chatJidsJson,
          limit: limit + 1
        });
      const events: Event[] = [];
      for (const row of rows.slice(0, limit)) {
        const { cursor, at, payload } = eventRowSchema.parse(row);
        const event = eventSchema.parse({ ...eventPayloadSchema.parse(JSON.parse(payload)), cursor, at });
        events.push(refreshEvent(event));
      }
      const hasMore = rows.length > limit;
      // Without more matches, the client may skip every non-matching event up to the head
      let next = head;
      const lastEvent = events.at(-1);
      if (hasMore && lastEvent !== undefined) {
        next = lastEvent.cursor;
      }
      return {
        events,
        next,
        hasMore
      };
    },

    eventsHead,

    // The cursor just before the oldest retained event, or the head when no event is retained
    oldestAvailableCursor() {
      const oldest = readCursor('SELECT min(cursor) AS cursor FROM events');
      if (oldest === null) {
        return eventsHead();
      }
      return oldest - 1;
    },

    cursorBefore(at) {
      const first = readCursor('SELECT min(cursor) AS cursor FROM events WHERE at >= ?', at);
      if (first === null) {
        return eventsHead();
      }
      return first - 1;
    },

    waitForEvent({ timeoutMs, signal }) {
      return new Promise((resolve) => {
        const wake = (): void => {
          clearTimeout(timer);
          signal.removeEventListener('abort', wake);
          waiters.delete(wake);
          resolve();
        };
        const timer = setTimeout(wake, timeoutMs);
        signal.addEventListener('abort', wake);
        waiters.add(wake);
      });
    },

    deleteRecordedBefore(cutoff) {
      const messages = database.prepare('DELETE FROM messages WHERE recorded_at < ?').run(cutoff);
      const events = database.prepare('DELETE FROM events WHERE at < ?').run(cutoff);
      return {
        messages: Number(messages.changes),
        events: Number(events.changes)
      };
    },

    findSend(idempotencyKey) {
      const row = database
        .prepare('SELECT chat_jid, message_id, outcome FROM send_ledger WHERE idempotency_key = ?')
        .get(idempotencyKey);
      if (row === undefined) {
        return null;
      }
      const send = sendRowSchema.parse(row);
      return {
        chatJid: send.chat_jid,
        messageId: send.message_id,
        outcome: send.outcome
      };
    },

    // Returns false when the key already has an entry, so at most one call sends for it
    reserveSend({ idempotencyKey, tool, chatJid, messageId }) {
      const result = database
        .prepare(
          `INSERT INTO send_ledger (idempotency_key, tool, chat_jid, message_id, outcome, created_at)
           VALUES (:idempotency_key, :tool, :chat_jid, :message_id, 'sending', :created_at)
           ON CONFLICT (idempotency_key) DO NOTHING`
        )
        .run({
          idempotency_key: idempotencyKey,
          tool,
          chat_jid: chatJid,
          message_id: messageId,
          created_at: new Date().toISOString()
        });
      return Number(result.changes) === 1;
    },

    finishSend({ idempotencyKey, outcome }) {
      database
        .prepare('UPDATE send_ledger SET outcome = :outcome WHERE idempotency_key = :idempotency_key')
        .run({ outcome, idempotency_key: idempotencyKey });
    },

    // Frees the key of a send that never reached WhatsApp, so a retry may send
    releaseSend(idempotencyKey) {
      database.prepare('DELETE FROM send_ledger WHERE idempotency_key = ?').run(idempotencyKey);
    },

    // A send still marked sending at startup was cut off by the previous process, and may have reached WhatsApp
    markInterruptedSends() {
      const result = database.prepare("UPDATE send_ledger SET outcome = 'ambiguous' WHERE outcome = 'sending'").run();
      return Number(result.changes);
    },

    // Message ids are random, so the id alone names the message whatever JID its chat was addressed by
    hasReceipt(messageId) {
      const row = database
        .prepare(
          `SELECT EXISTS (
             SELECT 1 FROM events WHERE type = 'receipt' AND json_extract(payload, '$.target.id') = ?
           ) AS value`
        )
        .get(messageId);
      return integerRowSchema.parse(row).value === 1;
    },

    deleteSendsBefore(cutoff) {
      const result = database.prepare('DELETE FROM send_ledger WHERE created_at < ?').run(cutoff);
      return Number(result.changes);
    }
  };
}
