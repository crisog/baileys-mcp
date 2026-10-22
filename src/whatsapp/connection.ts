import type { Logger } from 'pino';
import type {
  proto,
  WASocket,
  WAMessage,
  WAMessageKey,
  AnyMessageContent,
  AuthenticationCreds,
  AuthenticationState,
  ConnectionState as BaileysConnectionState
} from '@whiskeysockets/baileys';

import { z } from 'zod';
import { join } from 'node:path';
import { rm, chmod, mkdir, rename, writeFile } from 'node:fs/promises';
import {
  BufferJSON,
  makeWASocket,
  DisconnectReason,
  jidNormalizedUser,
  useMultiFileAuthState
} from '@whiskeysockets/baileys';

import type { Account } from './ingest.ts';
import type { Store, LastDisconnect, ConnectionState } from '../store.ts';

import { maskJid, createIngest } from './ingest.ts';
import { decodeStoredMessage } from './normalize.ts';
import { CONNECTION_STATES, lastDisconnectSchema } from '../store.ts';

const RECONNECT_DELAY_BASE_MS = 1_000;
const RECONNECT_DELAY_MAX_MS = 30_000;
const RECONNECT_EXPONENT_MAX = 5;
const PAIRING_START_TIMEOUT_MS = 20_000;
const SEND_TIMEOUT_MS = 60_000;
const TYPING_REFRESH_INTERVAL_MS = 10_000;
const AUTH_DIRECTORY_MODE = 0o700;
const CREDENTIALS_FILE = 'creds.json';
// Baileys puts JIDs, protocol nodes, and message keys in these fields of its warn and error lines
const BAILEYS_REDACTED_FIELDS = [
  'attrs',
  'child',
  'content',
  'err.data',
  'error.data',
  'from',
  'fromJid',
  'fullErrorNode',
  'jid',
  'key',
  'lid',
  'me',
  'myLID',
  'myPN',
  'node',
  'participant',
  'payloadNode',
  'pn',
  'reasonNode'
];

const boomSchema = z.object({ output: z.object({ statusCode: z.number() }) });

export const pairingSchema = z
  .discriminatedUnion('method', [
    z.object({ method: z.literal('qr'), qr: z.string() }),
    z.object({ method: z.literal('code'), code: z.string() })
  ])
  .describe('The QR string to render for the phone to scan, or the code to enter under Linked devices');

export const connectionStatusSchema = z.object({
  state: z.enum(CONNECTION_STATES),
  account: z.object({ phone_jid: z.string(), lid_jid: z.string().nullable() }).nullable(),
  last_disconnect: lastDisconnectSchema.nullable(),
  pairing: pairingSchema.nullable()
});

type PairingData = z.infer<typeof pairingSchema>;

type ConnectionStatus = z.infer<typeof connectionStatusSchema>;

export type PairRequest = { method: 'qr' } | { method: 'code'; phoneNumber: string };

type PairOutcome =
  | { kind: 'started'; state: ConnectionState; pairing: PairingData }
  | { kind: 'not_allowed'; message: string }
  | { kind: 'not_connected' };

type SendRequest = {
  jid: string;
  messageId: string;
  content: AnyMessageContent;
  quoted: WAMessage | undefined;
};

type SendOutcome =
  | { kind: 'sent' }
  | { kind: 'timed_out' }
  | { kind: 'failed'; error: unknown }
  | { kind: 'not_connected' };

type Presence = 'composing' | 'paused';

type TypingRequest = {
  socket: WASocket;
  chatJid: string;
  presence: Presence;
  ttlMs: number;
};

type TypingOutcome = { kind: 'set' } | { kind: 'not_connected' };

type TypingTimers = {
  refresh: NodeJS.Timeout;
  expiry: NodeJS.Timeout;
};

export interface WhatsAppConnection {
  start(): void;
  stop(): Promise<void>;
  getStatus(): ConnectionStatus;
  getOpenSocket(): WASocket | null;
  pair(request: PairRequest): Promise<PairOutcome>;
  send(request: SendRequest): Promise<SendOutcome>;
  setTyping(request: TypingRequest): Promise<TypingOutcome>;
}

type WhatsAppAuth = {
  state: AuthenticationState;
  saveCreds: () => Promise<void>;
};

type CreateWhatsAppConnectionParams = {
  authDirectory: string;
  store: Store;
  logger: Logger;
};

export function statusCodeOf(error: unknown): number | null {
  const result = boomSchema.safeParse(error);
  if (!result.success) {
    return null;
  }
  return result.data.output.statusCode;
}

export async function createWhatsAppConnection({
  authDirectory,
  store,
  logger
}: CreateWhatsAppConnectionParams): Promise<WhatsAppConnection> {
  const baileysLogger = logger.child({ component: 'baileys' }, { level: 'warn', redact: BAILEYS_REDACTED_FIELDS });
  const pendingWrites = new Set<Promise<unknown>>();
  let credentialsWrite: Promise<void> = Promise.resolve();
  let auth = await loadAuth();
  let socket: WASocket | null = null;
  let state: ConnectionState = 'closed';
  let lastDisconnect: LastDisconnect | null = null;
  let pairing: PairingData | null = null;
  let reconnectAttempt = 0;
  let reconnectTimer: NodeJS.Timeout | undefined;
  let isPairing = false;
  const typingByChat = new Map<string, TypingTimers>();
  const ingest = createIngest({ store, logger, getAccount });

  async function loadAuth(): Promise<WhatsAppAuth> {
    await mkdir(authDirectory, { recursive: true, mode: AUTH_DIRECTORY_MODE });
    // mkdir leaves the mode of an existing directory unchanged
    await chmod(authDirectory, AUTH_DIRECTORY_MODE);
    const { state: authState } = await useMultiFileAuthState(authDirectory);
    const { creds, keys } = authState;
    return {
      state: {
        creds,
        keys: {
          get: keys.get,
          set: (data) => trackWrite(Promise.resolve(keys.set(data)))
        }
      },
      saveCreds: () => saveCredentials(creds)
    };
  }

  // Baileys' own saveCreds rewrites creds.json in place, and its reader takes a half-written file for new credentials
  function saveCredentials(creds: AuthenticationCreds): Promise<void> {
    const write = credentialsWrite.then(async () => {
      const credentialsPath = join(authDirectory, CREDENTIALS_FILE);
      const temporaryPath = `${credentialsPath}.tmp`;
      await writeFile(temporaryPath, JSON.stringify(creds, BufferJSON.replacer), { flush: true });
      // A rename replaces the file in one step, so a crash leaves either the previous credentials or the new ones
      await rename(temporaryPath, credentialsPath);
    });
    // Writes take turns on the temporary file; each caller still receives the failure of its own write
    credentialsWrite = write.catch(() => undefined);
    return write;
  }

  // Shutdown and pairing wait for these, so a half-written credential file never survives
  function trackWrite<T>(write: Promise<T>): Promise<T> {
    pendingWrites.add(write);
    const forget = (): void => {
      pendingWrites.delete(write);
    };
    write.then(forget, forget);
    return write;
  }

  function isLinked(): boolean {
    return auth.state.creds.account !== undefined;
  }

  function getAccount(): Account | null {
    const { me } = auth.state.creds;
    if (!isLinked() || me === undefined) {
      return null;
    }
    let lidJid: string | null = null;
    if (me.lid) {
      lidJid = jidNormalizedUser(me.lid);
    }
    return {
      phoneJid: jidNormalizedUser(me.id),
      lidJid,
      name: me.name ?? null
    };
  }

  function setState(next: ConnectionState): void {
    if (next === state) {
      return;
    }
    state = next;
    logger.info({ state, disconnect_code: lastDisconnect?.code ?? null }, 'whatsapp connection state');
    store.recordEvent({
      body: { type: 'connection', state, last_disconnect: lastDisconnect },
      chatJid: null,
      factKey: null
    });
  }

  function openSocket(): WASocket {
    const boundAuth = auth;
    const current = makeWASocket({
      auth: boundAuth.state,
      logger: baileysLogger,
      markOnlineOnConnect: false,
      syncFullHistory: false,
      emitOwnEvents: true,
      getMessage: async (key) => findMessageContent(key)
    });
    socket = current;
    current.ev.on('creds.update', () => {
      // A pair call replaces the credentials, and a late write from the ended socket must not restore them
      if (auth !== boundAuth) {
        return;
      }
      trackWrite(boundAuth.saveCreds()).catch((error: unknown) => {
        logger.error({ err: error }, 'failed to save WhatsApp credentials');
      });
    });
    current.ev.on('connection.update', (update) => {
      handleConnectionUpdate(current, update);
    });
    current.ev.on('messages.upsert', ({ messages }) => {
      ingest.messages(messages);
    });
    current.ev.on('messages.update', (updates) => {
      ingest.statusUpdates(updates);
    });
    current.ev.on('message-receipt.update', (updates) => {
      ingest.receipts(updates);
    });
    current.ev.on('lid-mapping.update', (mapping) => {
      ingest.identity(mapping);
    });
    return current;
  }

  // Answers Baileys when a recipient asks for a retry of a message the account sent
  function findMessageContent(key: WAMessageKey): proto.IMessage | undefined {
    if (!key.remoteJid || !key.id) {
      return undefined;
    }
    const stored = store.findMessage({ chatJid: jidNormalizedUser(key.remoteJid), id: key.id });
    if (stored === null) {
      logger.debug({ message_id: key.id }, 'retry request for a message that is not stored');
      return undefined;
    }
    return decodeStoredMessage(stored.raw).message ?? undefined;
  }

  function handleConnectionUpdate(current: WASocket, update: Partial<BaileysConnectionState>): void {
    if (current !== socket) {
      return;
    }
    if (update.qr !== undefined) {
      reconnectAttempt = 0;
      // QR rotation continues after a pairing code request; the code stays the pairing data
      if (pairing?.method !== 'code') {
        pairing = { method: 'qr', qr: update.qr };
      }
      setState('pairing');
    }
    if (update.connection === 'open') {
      reconnectAttempt = 0;
      pairing = null;
      const account = getAccount();
      if (account !== null && account.lidJid !== null) {
        ingest.identity({ lid: account.lidJid, pn: account.phoneJid });
      }
      setState('open');
    }
    if (update.connection === 'close') {
      handleClose(update.lastDisconnect);
    }
  }

  function handleClose(disconnect: BaileysConnectionState['lastDisconnect']): void {
    socket = null;
    pairing = null;
    for (const chatJid of typingByChat.keys()) {
      clearTyping(chatJid);
    }
    const code = statusCodeOf(disconnect?.error);
    lastDisconnect = {
      code,
      at: (disconnect?.date ?? new Date()).toISOString()
    };
    if (code === DisconnectReason.loggedOut) {
      logger.warn('WhatsApp logged the account out; call pair to link it again');
      setState('logged_out');
      return;
    }
    // WhatsApp closes the connection right after a successful pairing and expects an immediate reconnect
    if (code === DisconnectReason.restartRequired) {
      setState('connecting');
      openSocket();
      return;
    }
    if (code === DisconnectReason.connectionReplaced) {
      scheduleReconnect('replaced');
      return;
    }
    scheduleReconnect('reconnecting');
  }

  function scheduleReconnect(nextState: 'reconnecting' | 'replaced'): void {
    setState(nextState);
    const exponential = RECONNECT_DELAY_BASE_MS * 2 ** Math.min(reconnectAttempt, RECONNECT_EXPONENT_MAX);
    const delay = Math.min(RECONNECT_DELAY_MAX_MS, exponential + Math.random() * RECONNECT_DELAY_BASE_MS);
    reconnectAttempt += 1;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = undefined;
      openSocket();
    }, delay);
  }

  async function endSocket(): Promise<void> {
    clearTimeout(reconnectTimer);
    reconnectTimer = undefined;
    const current = socket;
    // Clearing the socket first makes its close event a no-op
    socket = null;
    pairing = null;
    await current?.end(undefined);
    await Promise.allSettled(pendingWrites);
  }

  function getOpenSocket(): WASocket | null {
    if (state !== 'open') {
      return null;
    }
    return socket;
  }

  // Indicators are keyed by the phone JID when known, so a send to either JID of a DM stops its indicator
  function typingJidOf(jid: string): string {
    return store.resolveJid(jidNormalizedUser(jid));
  }

  // Returns true when the chat had a typing indicator
  function clearTyping(chatJid: string): boolean {
    const timers = typingByChat.get(chatJid);
    if (timers === undefined) {
      return false;
    }
    clearInterval(timers.refresh);
    clearTimeout(timers.expiry);
    typingByChat.delete(chatJid);
    return true;
  }

  // Typing indicators are best effort: a failure is logged, and the returned promise never rejects
  async function sendPresence(presence: Presence, chatJid: string): Promise<void> {
    const current = getOpenSocket();
    if (current === null) {
      return;
    }
    try {
      await current.sendPresenceUpdate(presence, chatJid);
    } catch (error) {
      logger.warn({ err: error, chat: maskJid(chatJid), presence }, 'failed to send a typing indicator');
    }
  }

  async function stopTyping(chatJid: string): Promise<void> {
    if (clearTyping(chatJid)) {
      await sendPresence('paused', chatJid);
    }
  }

  async function restartPairing(request: PairRequest): Promise<PairOutcome> {
    await endSocket();
    // Unlinked or logged-out credentials hold nothing worth keeping
    await rm(authDirectory, { recursive: true, force: true });
    auth = await loadAuth();
    setState('connecting');
    const current = openSocket();
    try {
      await current.waitForConnectionUpdate(async (update) => update.qr !== undefined, PAIRING_START_TIMEOUT_MS);
      if (request.method === 'code') {
        pairing = { method: 'code', code: await current.requestPairingCode(request.phoneNumber) };
      }
    } catch (error) {
      logger.warn({ err: error }, 'WhatsApp did not start pairing');
      return { kind: 'not_connected' };
    }
    if (pairing === null) {
      return { kind: 'not_connected' };
    }
    return {
      kind: 'started',
      state,
      pairing
    };
  }

  return {
    start() {
      setState('connecting');
      openSocket();
    },

    async stop() {
      await Promise.all([...typingByChat.keys()].map(stopTyping));
      await endSocket();
      setState('closed');
    },

    getStatus() {
      const account = getAccount();
      let accountStatus: ConnectionStatus['account'] = null;
      if (account !== null) {
        accountStatus = { phone_jid: account.phoneJid, lid_jid: account.lidJid };
      }
      return {
        state,
        account: accountStatus,
        last_disconnect: lastDisconnect,
        pairing
      };
    },

    getOpenSocket,

    async pair(request) {
      if (state === 'open') {
        return { kind: 'not_allowed', message: 'The account is linked and connected.' };
      }
      // A linked account that is only disconnected keeps its credentials
      if (isLinked() && state !== 'logged_out') {
        return { kind: 'not_allowed', message: `The account is linked and the connection is ${state}.` };
      }
      if (isPairing) {
        return { kind: 'not_allowed', message: 'Another pair call is in progress.' };
      }
      isPairing = true;
      try {
        return await restartPairing(request);
      } finally {
        isPairing = false;
      }
    },

    async send({ jid, messageId, content, quoted }) {
      const current = getOpenSocket();
      if (current === null) {
        return { kind: 'not_connected' };
      }
      // The paused indicator is best effort, so the send does not wait for it
      stopTyping(typingJidOf(jid));
      const sending = current.sendMessage(jid, content, { messageId, quoted }).then(
        (message): SendOutcome => {
          // Baileys also echoes the sent message later; recording it now lets the next call reply to it or edit it
          if (message !== undefined) {
            ingest.messages([message]);
          }
          return { kind: 'sent' };
        },
        (error: unknown): SendOutcome => ({ kind: 'failed', error })
      );
      let timer: NodeJS.Timeout | undefined;
      const timeout = new Promise<SendOutcome>((resolve) => {
        timer = setTimeout(() => {
          resolve({ kind: 'timed_out' });
        }, SEND_TIMEOUT_MS);
      });
      const outcome = await Promise.race([sending, timeout]);
      clearTimeout(timer);
      if (outcome.kind === 'timed_out') {
        // The close event of the stalled socket takes the normal reconnect path
        current.end(new Error(`A send did not finish within ${SEND_TIMEOUT_MS} ms`)).catch((error: unknown) => {
          logger.warn({ err: error }, 'failed to end the stalled WhatsApp socket');
        });
      }
      return outcome;
    },

    async setTyping({ socket: current, chatJid, presence, ttlMs }) {
      const typingJid = typingJidOf(chatJid);
      clearTyping(typingJid);
      try {
        await current.sendPresenceUpdate(presence, typingJid);
      } catch (error) {
        logger.warn({ err: error, chat: maskJid(typingJid), presence }, 'failed to send a typing indicator');
        return { kind: 'not_connected' };
      }
      if (presence === 'composing') {
        // A concurrent call for the same chat may have set timers while this one waited
        clearTyping(typingJid);
        typingByChat.set(typingJid, {
          refresh: setInterval(() => sendPresence('composing', typingJid), TYPING_REFRESH_INTERVAL_MS),
          expiry: setTimeout(() => stopTyping(typingJid), ttlMs)
        });
      }
      return { kind: 'set' };
    }
  };
}
