import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import { z } from 'zod';

import type { ToolServices } from './register.ts';

import { eventSchema, EVENT_TYPES } from '../store.ts';
import { toolError, toolResult, chatJidsFor, chatRefSchema, isoTimeSchema } from './results.ts';

const EVENTS_LIMIT_DEFAULT = 100;
const EVENTS_LIMIT_MAX = 500;
const WAIT_MS_MAX = 25_000;
const CHAT_FILTER_MAX = 100;

const pullEventsInputSchema = z
  .object({
    after: z
      .number()
      .int()
      .min(0)
      .optional()
      .describe('Return the events after this cursor, the next of a previous call'),
    since: isoTimeSchema
      .optional()
      .describe('Start at the first event recorded at or after this ISO 8601 time, for a client without a cursor'),
    types: z.array(z.enum(EVENT_TYPES)).min(1).optional().describe('Only events of these types'),
    chats: z.array(chatRefSchema).min(1).max(CHAT_FILTER_MAX).optional().describe('Only events of these chats'),
    limit: z.number().int().min(1).max(EVENTS_LIMIT_MAX).default(EVENTS_LIMIT_DEFAULT),
    wait_ms: z
      .number()
      .int()
      .min(0)
      .max(WAIT_MS_MAX)
      .default(0)
      .describe('When no event matches, wait up to this long for one before returning an empty list')
  })
  .refine((input) => input.after === undefined || input.since === undefined, {
    message: 'Give after or since, not both',
    path: ['since']
  });

const pullEventsOutputSchema = z.object({
  events: z.array(eventSchema),
  next: z.number().int().describe('The cursor to pass as after in the next call'),
  has_more: z.boolean()
});

export function registerEventsTool(server: McpServer, { store }: ToolServices): void {
  server.registerTool(
    'pull_events',
    {
      description:
        'Inbound events in the order the server recorded them, after a cursor or from a time. With wait_ms, returns as soon as a matching event is recorded. Without after or since, starts at the oldest retained event.',
      inputSchema: pullEventsInputSchema,
      outputSchema: pullEventsOutputSchema,
      annotations: { readOnlyHint: true }
    },
    async ({ after, since, types, chats, limit, wait_ms }, { signal }) => {
      const firstRetained = store.firstRetainedCursor();
      let start = firstRetained - 1;
      if (after !== undefined) {
        // A cursor past the head was issued by another database and would skip events silently
        if (after < firstRetained - 1 || after > store.eventsHead()) {
          return toolError({
            code: 'invalid_cursor',
            message: `Cursor ${after} is outside the retained event log. Resume with after: ${firstRetained - 1}.`,
            retryable: false,
            oldest_available: firstRetained - 1
          });
        }
        start = after;
      } else if (since !== undefined) {
        start = store.cursorBefore(since);
      }

      let chatJids: string[] | undefined;
      if (chats !== undefined) {
        chatJids = chats.flatMap((chat) => chatJidsFor(store, chat));
      }
      const query = { types, chatJids, limit };
      const deadline = Date.now() + wait_ms;
      let page = store.readEvents({ ...query, after: start });
      while (page.events.length === 0 && Date.now() < deadline && !signal.aborted) {
        await store.waitForEvent({ timeoutMs: deadline - Date.now(), signal });
        page = store.readEvents({ ...query, after: page.next });
      }
      const result = {
        events: page.events,
        next: page.next,
        has_more: page.hasMore
      } satisfies z.infer<typeof pullEventsOutputSchema>;
      return toolResult(result);
    }
  );
}
