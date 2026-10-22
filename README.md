# baileys-mcp

An [MCP](https://modelcontextprotocol.io) server that gives AI agents access to a WhatsApp account through [Baileys](https://github.com/WhiskeySockets/Baileys), served over Streamable HTTP.

The server serves MCP at `/mcp` behind OAuth. It is its own authorization server: MCP clients discover it from the `/mcp` URL, and the operator signs in with GitHub and approves each client. The server keeps one WhatsApp connection open, stores every message and event it receives, and lets clients read, wait for, and send messages through the tools below.

Baileys is an unofficial WhatsApp Web client. WhatsApp can change its protocol or restrict an account that uses it, so link a dedicated number.

Status: all v1 tools are implemented. They have been exercised against a running server with no phone linked; behavior that needs a linked phone, such as real sends, receipts, and media, has not been verified yet.

## Tools

| Tool               | What it does                                                                                                                                                             |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `get_status`       | Returns the connection state, the linked account, the last disconnect, the pairing QR string or code while pairing, and the newest event cursor.                         |
| `pair`             | Links a phone: `method: "qr"` restarts QR pairing, and `method: "code"` with `phone_number` returns a code to enter on the phone.                                        |
| `list_chats`       | Lists the groups the account is in and the direct chats with stored messages, most recent first.                                                                         |
| `list_messages`    | Lists the stored messages of one chat, newest first, with optional `since`, `before`, and `limit`.                                                                       |
| `pull_events`      | Returns inbound events after a cursor (`after`) or from a time (`since`), filtered by `types` and `chats`. With `wait_ms` (at most 25 000), it waits for the next event. |
| `download_media`   | Returns the photo, video, audio, document, or sticker of a stored message by its `media_id`, up to 10 MiB.                                                               |
| `send_message`     | Sends text, an image, a video, a GIF, audio, a voice note, a document, a sticker, a location, or a poll, optionally as a reply and with mentions.                        |
| `edit_message`     | Replaces the text of a message the account sent.                                                                                                                         |
| `react_to_message` | Sets the account's reaction on a message to one emoji, or removes it with `emoji: null`.                                                                                 |
| `mark_read`        | Sends read receipts for 1 to 100 stored messages.                                                                                                                        |
| `set_typing`       | Shows the typing indicator in a chat, refreshed every 10 s, or stops it.                                                                                                 |

A chat or participant is a phone JID (`5215512345678@s.whatsapp.net`), a LID JID (`123456789@lid`), a group JID (`120363000000000000@g.us`), or an E.164 number (`+5215512345678`). A failed call returns `isError: true` with `{ code, message, retryable }`. [SPEC.md](SPEC.md) defines every input, output, and error code.

## Configure

Set these environment variables. The server does not start when a required one is missing or invalid.

| Variable               | Required | Description                                                                                                                                                                        |
| ---------------------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PUBLIC_BASE_URL`      | yes      | The public origin, such as `https://mcp.example.com`, with no path or trailing slash. It must be HTTPS, except on `localhost`.                                                     |
| `DATA_DIR`             | yes      | Directory for the SQLite database and the WhatsApp credentials. Put it on a persistent volume: it holds the OAuth state, the WhatsApp session, and the stored messages and events. |
| `BETTER_AUTH_SECRET`   | yes      | At least 32 random characters, for example from `openssl rand -base64 32`. It signs sessions and encrypts the token signing keys.                                                  |
| `GITHUB_CLIENT_ID`     | yes      | Client ID of the GitHub OAuth app the operator signs in with.                                                                                                                      |
| `GITHUB_CLIENT_SECRET` | yes      | Client secret of that GitHub OAuth app.                                                                                                                                            |
| `OPERATOR_GITHUB_ID`   | yes      | The operator's numeric GitHub user ID (`gh api user --jq .id`). No other GitHub account can sign in.                                                                               |
| `PORT`                 | no       | The listen port. The default is `3000`.                                                                                                                                            |
| `RETENTION_DAYS`       | no       | The number of days the server keeps stored messages and events. The default is `30`.                                                                                               |
| `CLIENT_IP_HEADER`     | no       | Set it behind a reverse proxy, to a header the proxy overwrites with the client address, such as `x-real-ip`. Unset, the rate limits count the TCP peer, which is then the proxy.  |

Create the GitHub OAuth app with the authorization callback URL `${PUBLIC_BASE_URL}/api/auth/callback/github`.

The server applies its database migrations at startup. Run exactly one server process per `DATA_DIR`.

## Run

```bash
nvm use
npm ci
npm start
```

## Link the phone

On its first start the server begins QR pairing. Call `get_status` and render its `pairing.qr` string as a QR code, then scan it on the phone under Linked devices. To link with a code instead, call `pair` with `method: "code"` and the phone number in E.164 form, then enter the returned code on the phone. When WhatsApp logs the account out, `get_status` reports `logged_out` and `pair` links the phone again.

## Receive messages

`pull_events` is how a client learns about new activity. Each event has a `cursor` and one of these types: `message`, `message_edited`, `message_deleted`, `reaction`, `receipt`, `poll_vote`, `identity_mapped`, and `connection`. The server records events whether or not a client is connected, so a client that keeps the `next` cursor of each call and passes it as `after` in the next call misses nothing, also across restarts. A client calls `pull_events` with `wait_ms` in a loop to get new events as soon as they arrive.

The server keeps messages and events for `RETENTION_DAYS`. A cursor older than that returns `invalid_cursor` with the oldest cursor still available.

## Send messages

`send_message`, `edit_message`, and `react_to_message` require an `idempotency_key`. A repeated call with the same key returns the first outcome and sends nothing, so a client can retry a call safely. The server keeps each key for 7 days.

When a send does not finish within 60 s, the result is `status: "ambiguous"` with the message id, and the server reconnects to WhatsApp. The server never sends that message again: a later call with the same key returns `send_ambiguous` until a `receipt` event for the message id arrives, and the result `sent` after it.

`send_message` takes media as base64 with its MIME type, up to 10 MiB, or as the `media_id` of a stored message. The server does not convert media, so a sticker must be `image/webp` and a voice note `audio/ogg; codecs=opus`.

The server sends read receipts and typing indicators only when a client calls `mark_read` or `set_typing`.

## Connect clients

An MCP client adds `${PUBLIC_BASE_URL}/mcp` with no headers and chooses Authorize. The operator signs in with GitHub and approves the client on the consent page.

A headless service uses the client credentials grant. Sign in once at `${PUBLIC_BASE_URL}/sign-in`, then register a client on the server host, with the same environment as the server:

```bash
npm run register-client -- --name "My service"
```

The command prints the client ID and secret once. The service requests a token with them:

```bash
curl -u "$CLIENT_ID:$CLIENT_SECRET" "$PUBLIC_BASE_URL/api/auth/oauth2/token" \
  -d grant_type=client_credentials -d scope=whatsapp \
  --data-urlencode "resource=$PUBLIC_BASE_URL/mcp"
```

## Develop

`npm run verify` runs every check that CI runs. [DRIVER.md](DRIVER.md) shows how to run the server locally and call it with `curl`, without a GitHub OAuth app or a linked phone.

## License

[MIT](LICENSE)
