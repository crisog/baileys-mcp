import type { Logger } from 'pino';
import type {
  LIDMapping,
  WAMessage,
  WAMessageKey,
  WAMessageUpdate,
  MessageUserReceiptUpdate
} from '@whiskeysockets/baileys';

import { createHash, hkdfSync, createDecipheriv } from 'node:crypto';
import {
  proto,
  isPnUser,
  isJidGroup,
  isLidUser,
  getContentType,
  decryptPollVote,
  jidNormalizedUser,
  normalizeMessageContent
} from '@whiskeysockets/baileys';

import type { Store, Message, Participant, ReceiptState } from '../store.ts';

import { textOf, toIsoTime, encodeMediaId, normalizeContent } from './normalize.ts';

const AES_GCM_TAG_BYTES = 16;
const EDIT_KEY_BYTES = 32;
const EDIT_KEY_INFO = 'Message Edit';

export type Account = {
  phoneJid: string;
  lidJid: string | null;
  name: string | null;
};

type CreateIngestParams = {
  store: Store;
  logger: Logger;
  getAccount: () => Account | null;
};

interface Ingest {
  messages(messages: WAMessage[]): void;
  statusUpdates(updates: WAMessageUpdate[]): void;
  receipts(updates: MessageUserReceiptUpdate[]): void;
  identity(mapping: LIDMapping): void;
}

type DecryptEditParams = {
  encrypted: proto.Message.ISecretEncryptedMessage;
  messageSecret: Uint8Array;
  targetId: string;
  senderJids: string[];
};

type DecryptVoteParams = {
  vote: proto.Message.IPollEncValue;
  messageSecret: Uint8Array;
  pollId: string;
  creatorJids: string[];
  voterJids: string[];
};

type RecordReceiptParams = {
  chatJid: string;
  id: string;
  participant: Participant | null;
  state: ReceiptState;
};

type SkippedEdit = {
  editId: string;
  targetId: string;
  chatJid: string;
};

export function createIngest({ store, logger, getAccount }: CreateIngestParams): Ingest {
  function accountParticipant(): Participant {
    const account = getAccount();
    if (account === null) {
      throw new Error('Received an own message before the account identity is known');
    }
    return {
      jid: account.phoneJid,
      phone_jid: account.phoneJid,
      lid_jid: account.lidJid,
      name: account.name
    };
  }

  function senderOf(key: WAMessageKey, name: string | null): Participant {
    if (key.fromMe === true) {
      return accountParticipant();
    }
    return store.participantFor(jidNormalizedUser(key.participant || key.remoteJid || ''), name);
  }

  // Baileys addresses a sender by LID or by phone number and names the other form in the Alt field
  function learnKeyIdentities(key: WAMessageKey): void {
    learnPair(key.participant, key.participantAlt);
    learnPair(key.remoteJid, key.remoteJidAlt);
  }

  function learnPair(primary: string | null | undefined, alternate: string | null | undefined): void {
    if (!primary || !alternate) {
      return;
    }
    const first = jidNormalizedUser(primary);
    const second = jidNormalizedUser(alternate);
    if (isLidUser(first) && isPnUser(second)) {
      store.learnIdentity({ lidJid: first, phoneJid: second });
    } else if (isPnUser(first) && isLidUser(second)) {
      store.learnIdentity({ lidJid: second, phoneJid: first });
    }
  }

  function ingestMessage(waMessage: WAMessage): void {
    const { key } = waMessage;
    const chatJid = jidNormalizedUser(key.remoteJid ?? '');
    if (!key.id || !isChat(chatJid)) {
      return;
    }
    learnKeyIdentities(key);
    // Stubs such as group notifications and undecryptable placeholders carry no content
    const content = normalizeMessageContent(waMessage.message);
    if (content === undefined) {
      return;
    }
    if (content.protocolMessage) {
      ingestProtocolMessage(waMessage, content.protocolMessage, chatJid);
      return;
    }
    if (content.secretEncryptedMessage) {
      ingestEncryptedEdit(waMessage, content.secretEncryptedMessage, chatJid);
      return;
    }
    if (content.pollUpdateMessage) {
      ingestPollVote(waMessage, content.pollUpdateMessage, chatJid);
      return;
    }
    // Baileys also emits messages.reaction, but its event buffer folds that event into a target message it still holds
    if (content.reactionMessage) {
      ingestReaction(waMessage, content.reactionMessage, chatJid);
      return;
    }
    if (getContentType(content) === undefined) {
      return;
    }

    const normalized = normalizeContent(content, encodeMediaId({ chatJid, id: key.id }));
    const message: Message = {
      chat: chatJid,
      chat_kind: chatKindOf(chatJid),
      id: key.id,
      from_me: key.fromMe === true,
      sender: senderOf(key, waMessage.pushName ?? null),
      timestamp: toIsoTime(waMessage.messageTimestamp),
      ...normalized,
      edited_at: null,
      deleted_at: null
    };
    const messageSecret =
      waMessage.message?.messageContextInfo?.messageSecret ?? content.messageContextInfo?.messageSecret ?? null;
    store.recordMessage({
      chatJid,
      message,
      raw: proto.WebMessageInfo.encode(waMessage).finish(),
      messageSecret
    });
    // The event buffer folds a receipt for a message it still holds into the message and emits no receipt event
    ingestStatusUpdate({ key, update: { status: waMessage.status } });
    for (const receipt of waMessage.userReceipt ?? []) {
      ingestReceipt({ key, receipt });
    }
  }

  function ingestProtocolMessage(
    waMessage: WAMessage,
    protocolMessage: proto.Message.IProtocolMessage,
    chatJid: string
  ): void {
    const operationId = waMessage.key.id;
    const targetId = protocolMessage.key?.id;
    if (!operationId || !targetId) {
      return;
    }
    if (protocolMessage.type === proto.Message.ProtocolMessage.Type.REVOKE) {
      store.recordDelete({
        chatJid,
        factKey: `message_deleted:${chatJid}:${operationId}`,
        targetId,
        by: senderOf(waMessage.key, waMessage.pushName ?? null),
        deletedAt: toIsoTime(waMessage.messageTimestamp)
      });
      return;
    }
    if (protocolMessage.type !== proto.Message.ProtocolMessage.Type.MESSAGE_EDIT) {
      return;
    }
    const text = textOf(protocolMessage.editedMessage);
    if (text === null) {
      return;
    }
    const by = senderOf(waMessage.key, waMessage.pushName ?? null);
    const target = store.findMessage({ chatJid, id: targetId });
    if (target !== null && !isSameParticipant(target.message.sender, by)) {
      logSkippedEdit({ editId: operationId, targetId, chatJid });
      return;
    }
    store.recordEdit({
      chatJid,
      factKey: `message_edited:${chatJid}:${operationId}`,
      targetId,
      text,
      by,
      editedAt: editTime(protocolMessage, waMessage)
    });
  }

  function ingestEncryptedEdit(
    waMessage: WAMessage,
    encrypted: proto.Message.ISecretEncryptedMessage,
    chatJid: string
  ): void {
    const editId = waMessage.key.id;
    const targetId = encrypted.targetMessageKey?.id;
    if (encrypted.secretEncType !== proto.Message.SecretEncryptedMessage.SecretEncType.MESSAGE_EDIT) {
      return;
    }
    if (!editId || !targetId) {
      return;
    }
    const target = store.findMessage({ chatJid, id: targetId });
    if (target === null || target.messageSecret === null) {
      logger.debug(
        { message_id: editId, target_id: targetId, chat: maskJid(chatJid) },
        'skipped an encrypted edit whose original message or secret is not stored'
      );
      return;
    }
    const by = senderOf(waMessage.key, waMessage.pushName ?? null);
    if (!isSameParticipant(target.message.sender, by)) {
      logSkippedEdit({ editId, targetId, chatJid });
      return;
    }
    const plaintext = decryptEdit({
      encrypted,
      messageSecret: target.messageSecret,
      targetId,
      senderJids: jidsOf(by)
    });
    if (plaintext === null) {
      logger.debug(
        { message_id: editId, target_id: targetId, chat: maskJid(chatJid) },
        'failed to decrypt an encrypted edit'
      );
      return;
    }
    const edit = proto.Message.decode(plaintext).protocolMessage;
    const text = textOf(edit?.editedMessage);
    if (
      !edit ||
      edit.type !== proto.Message.ProtocolMessage.Type.MESSAGE_EDIT ||
      edit.key?.id !== targetId ||
      text === null
    ) {
      logger.debug(
        { message_id: editId, target_id: targetId, chat: maskJid(chatJid) },
        'skipped a decrypted edit that does not edit its target'
      );
      return;
    }
    store.recordEdit({
      chatJid,
      factKey: `message_edited:${chatJid}:${editId}`,
      targetId,
      text,
      by,
      editedAt: editTime(edit, waMessage)
    });
  }

  // WhatsApp clients ignore an edit from anyone but the original sender; the store does too
  function logSkippedEdit({ editId, targetId, chatJid }: SkippedEdit): void {
    logger.debug(
      { message_id: editId, target_id: targetId, chat: maskJid(chatJid) },
      'skipped an edit from a participant who did not send the message'
    );
  }

  function ingestPollVote(waMessage: WAMessage, update: proto.Message.IPollUpdateMessage, chatJid: string): void {
    const voteId = waMessage.key.id;
    const pollId = update.pollCreationMessageKey?.id;
    if (!voteId || !pollId || !update.vote) {
      return;
    }
    const poll = store.findMessage({ chatJid, id: pollId });
    if (poll === null || poll.message.poll === null || poll.messageSecret === null) {
      logger.debug(
        { message_id: voteId, poll_id: pollId, chat: maskJid(chatJid) },
        'skipped a vote for a poll that is not stored'
      );
      return;
    }
    const voter = senderOf(waMessage.key, waMessage.pushName ?? null);
    const selectedHashes = decryptVote({
      vote: update.vote,
      messageSecret: poll.messageSecret,
      pollId,
      creatorJids: jidsOf(poll.message.sender),
      voterJids: jidsOf(voter)
    });
    if (selectedHashes === null) {
      logger.debug({ message_id: voteId, poll_id: pollId, chat: maskJid(chatJid) }, 'failed to decrypt a poll vote');
      return;
    }
    const selectedOptions = matchOptions(selectedHashes, poll.message.poll.options);
    if (selectedOptions === null) {
      logger.debug(
        { message_id: voteId, poll_id: pollId, chat: maskJid(chatJid) },
        'skipped a poll vote whose options match no poll option'
      );
      return;
    }
    store.recordEvent({
      body: {
        type: 'poll_vote',
        poll: { chat: chatJid, id: pollId },
        voter,
        selected_options: selectedOptions
      },
      chatJid,
      factKey: `poll_vote:${chatJid}:${voteId}`
    });
  }

  function ingestReaction(waMessage: WAMessage, reaction: proto.Message.IReactionMessage, chatJid: string): void {
    const reactionId = waMessage.key.id;
    const targetId = reaction.key?.id;
    if (!reactionId || !targetId) {
      return;
    }
    let emoji: string | null = null;
    if (reaction.text) {
      emoji = reaction.text;
    }
    store.recordEvent({
      body: {
        type: 'reaction',
        target: { chat: chatJid, id: targetId },
        reactor: senderOf(waMessage.key, waMessage.pushName ?? null),
        emoji
      },
      chatJid,
      factKey: `reaction:${chatJid}:${reactionId}`
    });
  }

  function ingestStatusUpdate({ key, update }: WAMessageUpdate): void {
    const chatJid = jidNormalizedUser(key.remoteJid ?? '');
    if (key.fromMe !== true || !key.id || !isChat(chatJid) || typeof update.status !== 'number') {
      return;
    }
    const state = receiptStateOf(update.status);
    if (state === null) {
      return;
    }
    // A DM status comes from the other participant; a group status names nobody
    let participant: Participant | null = null;
    if (state !== 'server_ack' && !isJidGroup(chatJid)) {
      participant = store.participantFor(chatJid, null);
    }
    recordReceipt({ chatJid, id: key.id, participant, state });
  }

  function ingestReceipt({ key, receipt }: MessageUserReceiptUpdate): void {
    const chatJid = jidNormalizedUser(key.remoteJid ?? '');
    if (key.fromMe !== true || !key.id || !receipt.userJid || !isChat(chatJid)) {
      return;
    }
    const participant = store.participantFor(jidNormalizedUser(receipt.userJid), null);
    // The event buffer merges the receipts of one participant into one entry, so each timestamp is its own receipt
    if (receipt.receiptTimestamp) {
      recordReceipt({ chatJid, id: key.id, participant, state: 'delivered' });
    }
    if (receipt.readTimestamp) {
      recordReceipt({ chatJid, id: key.id, participant, state: 'read' });
    }
    if (receipt.playedTimestamp) {
      recordReceipt({ chatJid, id: key.id, participant, state: 'played' });
    }
  }

  function recordReceipt({ chatJid, id, participant, state }: RecordReceiptParams): void {
    let participantKey = 'server';
    if (participant !== null) {
      participantKey = participant.jid;
    }
    store.recordEvent({
      body: {
        type: 'receipt',
        target: { chat: chatJid, id },
        participant,
        state
      },
      chatJid,
      factKey: `receipt:${chatJid}:${id}:${participantKey}:${state}`
    });
  }

  // One failed item is logged by its key and the rest of the batch still records
  function forEachItem<T>(items: T[], ingest: (item: T) => void, describe: (item: T) => object): void {
    for (const item of items) {
      try {
        ingest(item);
      } catch (error) {
        logger.warn({ err: error, ...describe(item) }, 'failed to record a WhatsApp event');
      }
    }
  }

  return {
    messages(messages) {
      forEachItem(messages, ingestMessage, ({ key }) => describeKey('message', key));
    },
    statusUpdates(updates) {
      forEachItem(updates, ingestStatusUpdate, ({ key }) => describeKey('receipt', key));
    },
    receipts(updates) {
      forEachItem(updates, ingestReceipt, ({ key }) => describeKey('receipt', key));
    },
    identity(mapping) {
      forEachItem(
        [mapping],
        ({ lid, pn }) => learnPair(lid, pn),
        () => ({ event: 'identity_mapped' })
      );
    }
  };
}

function isChat(jid: string): boolean {
  return isJidGroup(jid) === true || isPnUser(jid) === true || isLidUser(jid) === true;
}

function chatKindOf(chatJid: string): Message['chat_kind'] {
  if (isJidGroup(chatJid)) {
    return 'group';
  }
  return 'dm';
}

function editTime(protocolMessage: proto.Message.IProtocolMessage, waMessage: WAMessage): string {
  if (protocolMessage.timestampMs) {
    return new Date(Number(protocolMessage.timestampMs)).toISOString();
  }
  return toIsoTime(waMessage.messageTimestamp);
}

function receiptStateOf(status: number): ReceiptState | null {
  const statuses = proto.WebMessageInfo.Status;
  if (status === statuses.SERVER_ACK) {
    return 'server_ack';
  }
  if (status === statuses.DELIVERY_ACK) {
    return 'delivered';
  }
  if (status === statuses.READ) {
    return 'read';
  }
  if (status === statuses.PLAYED) {
    return 'played';
  }
  return null;
}

function isSameParticipant(first: Participant, second: Participant): boolean {
  if (first.jid === second.jid) {
    return true;
  }
  if (first.lid_jid !== null && first.lid_jid === second.lid_jid) {
    return true;
  }
  return first.phone_jid !== null && first.phone_jid === second.phone_jid;
}

function jidsOf(participant: Participant): string[] {
  const jids: string[] = [];
  if (participant.phone_jid !== null) {
    jids.push(participant.phone_jid);
  }
  if (participant.lid_jid !== null) {
    jids.push(participant.lid_jid);
  }
  return jids;
}

// The sender may have keyed the edit with its phone JID or its LID, so each known form is tried
function decryptEdit({ encrypted, messageSecret, targetId, senderJids }: DecryptEditParams): Uint8Array | null {
  if (!encrypted.encPayload || !encrypted.encIv) {
    return null;
  }
  const payload = Buffer.from(encrypted.encPayload);
  const ciphertext = payload.subarray(0, -AES_GCM_TAG_BYTES);
  const authenticationTag = payload.subarray(-AES_GCM_TAG_BYTES);
  for (const originalSenderJid of senderJids) {
    for (const editorJid of senderJids) {
      const info = `${targetId}${originalSenderJid}${editorJid}${EDIT_KEY_INFO}`;
      const key = Buffer.from(hkdfSync('sha256', messageSecret, new Uint8Array(0), info, EDIT_KEY_BYTES));
      try {
        const decipher = createDecipheriv('aes-256-gcm', key, encrypted.encIv);
        decipher.setAuthTag(authenticationTag);
        return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
      } catch {
        // Authentication fails for a sender pair the editor did not use
        continue;
      }
    }
  }
  return null;
}

function decryptVote({ vote, messageSecret, pollId, creatorJids, voterJids }: DecryptVoteParams): Uint8Array[] | null {
  for (const pollCreatorJid of creatorJids) {
    for (const voterJid of voterJids) {
      try {
        return decryptPollVote(vote, { pollCreatorJid, pollEncKey: messageSecret, pollMsgId: pollId, voterJid })
          .selectedOptions;
      } catch {
        // Authentication fails for a creator and voter pair the voter did not use
        continue;
      }
    }
  }
  return null;
}

// A vote names options by the SHA-256 of their text; every hash must match an option
function matchOptions(selectedHashes: Uint8Array[], options: string[]): string[] | null {
  const selected = new Set<string>();
  for (const hash of selectedHashes) {
    selected.add(Buffer.from(hash).toString('hex'));
  }
  const matched: string[] = [];
  for (const option of options) {
    if (selected.has(createHash('sha256').update(option, 'utf8').digest('hex'))) {
      matched.push(option);
    }
  }
  if (matched.length !== selected.size) {
    return null;
  }
  return matched;
}

function describeKey(event: string, key: WAMessageKey): object {
  return {
    event,
    message_id: key.id,
    chat: maskJid(jidNormalizedUser(key.remoteJid ?? ''))
  };
}

// Logs keep the server and the last four digits, never a whole phone number
export function maskJid(jid: string): string {
  const separator = jid.indexOf('@');
  return `…${jid.slice(Math.max(0, separator - 4))}`;
}
