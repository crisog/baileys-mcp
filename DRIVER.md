# Driver

How to run the server locally and drive it through its public surface, for a bug bash or a manual check. `README.md` is the operator guide; this file adds the commands an agent needs to reproduce a run.

## Prerequisites

- Node 24.22.1 first on `PATH` (`nvm use` in the repository), and `npm ci` done.
- `curl`, `node`, and `openssl`.
- Network access to the WhatsApp servers. The server connects at startup even when no phone is linked.
- Never link a phone and never call `pair` with `method: "code"` and a real phone number during a run: that sends a notification to the phone.

## Launch from a clean state

1. Choose a free port and a new, empty run directory. Run one server process per data directory.

   ```bash
   RUN=/path/to/run-dir
   PORT=3917
   mkdir -p "$RUN/data" "$RUN/logs" "$RUN/http"
   lsof -iTCP:$PORT -sTCP:LISTEN    # no output means the port is free
   ```

2. Write the environment to a file only you can read. The GitHub values can be placeholders, because the run replaces the GitHub sign-in (see [Operator sign-in](#operator-sign-in)).

   ```bash
   umask 077
   cat > "$RUN/env.sh" <<EOF
   export DATA_DIR=$RUN/data
   export PORT=$PORT
   export PUBLIC_BASE_URL=http://localhost:$PORT
   export BETTER_AUTH_SECRET=$(openssl rand -base64 32)
   export GITHUB_CLIENT_ID=placeholder-client-id
   export GITHUB_CLIENT_SECRET=placeholder-client-secret
   export OPERATOR_GITHUB_ID=424242
   EOF
   ```

3. Start the server from the repository root and keep the PID.

   ```bash
   source "$RUN/env.sh"
   nohup npm start > "$RUN/logs/server.log" 2>&1 & echo $! > "$RUN/server.pid"
   ```

The server is ready when its log has the line `"msg":"server listening"`. About one second later, a `whatsapp connection state` line reports `state: "pairing"`.

```bash
grep -m1 '"msg":"server listening"' "$RUN/logs/server.log"
```

While no phone is linked, WhatsApp closes the unscanned QR session after about 2.5 minutes with code 408, and the server pairs again. The states `reconnecting` and `pairing` repeat in the log and the event log. This is normal.

## Health check

These requests need no credentials and change nothing.

```bash
curl -s "$PUBLIC_BASE_URL/api/auth/ok"                                  # {"ok":true}
curl -s "$PUBLIC_BASE_URL/.well-known/oauth-protected-resource/mcp"     # "resource" is $PUBLIC_BASE_URL/mcp
curl -s -o /dev/null -w '%{http_code}\n' -X POST "$PUBLIC_BASE_URL/mcp" # 401
```

The `resource` value proves that the running instance uses this run's configuration. Every unknown path returns 404.

## Operator sign-in

The operator signs in with GitHub at `$PUBLIC_BASE_URL/sign-in`, which needs a real GitHub OAuth app and a person. A local run replaces that step with this command, which writes the operator's account into the data directory through the server's own modules and prints a signed session cookie. It is not a product feature. Run it from the repository root with the server's environment:

```bash
source "$RUN/env.sh"
node --input-type=module -e "
import { pino } from 'pino';
import { serializeSignedCookie } from 'better-call';
import { parseConfig } from './src/config.ts';
import { openDatabase } from './src/database.ts';
import { createAuth } from './src/auth.ts';
const config = parseConfig(process.env);
const { database } = openDatabase(config.DATA_DIR);
const context = await createAuth({ config, database, logger: pino(pino.destination(2)) }).\$context;
const accountId = String(config.OPERATOR_GITHUB_ID);
let account = await context.internalAdapter.findAccountByKey({ providerId: 'github', accountId });
if (account === null) {
  const now = new Date();
  const user = await context.adapter.create({ model: 'user', data: { name: 'Operator', email: 'operator@example.test', emailVerified: true, createdAt: now, updatedAt: now } });
  account = await context.adapter.create({ model: 'account', data: { accountId, providerId: 'github', userId: user.id, createdAt: now, updatedAt: now } });
}
const session = await context.internalAdapter.createSession(account.userId);
process.stdout.write(await serializeSignedCookie(context.authCookies.sessionToken.name, session.token, context.secret) + '\n');
database.close();
" > "$RUN/cookie.txt"
```

Send `Cookie: $(cat "$RUN/cookie.txt")` wherever a browser would carry the operator session.

## Calling MCP

`/mcp` is stateless Streamable HTTP. Every request is a JSON-RPC POST:

```bash
mcp() { # mcp <access-token> <json-rpc-body>
  curl -sS -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
    -H "Authorization: Bearer $1" --data-binary "$2" "$PUBLIC_BASE_URL/mcp"
}
mcp "$TOKEN" '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
mcp "$TOKEN" '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"get_status","arguments":{}}}'
```

- The response is one server-sent event. Parse the JSON after `data: `.
- `initialize`, `Mcp-Session-Id`, and the `MCP-Protocol-Version` header are optional.
- A tool result has `structuredContent`. A tool error has `isError: true` and a text block with `{ "code", "message", "retryable" }`. Input that fails a schema returns `isError: true` with the text `MCP error -32602: Input validation error: ...` (DEC-015).
- A body larger than 15 029 592 bytes to `/mcp` returns 413. A body larger than 64 KiB to `/api/auth/*` or `/.well-known/*` returns 413.

## Role: interactive client

This role is an MCP client with no stored credentials, such as an IDE agent.

1. Discover. `POST /mcp` without a token returns 401 with a `www-authenticate` header that names `resource_metadata="$PUBLIC_BASE_URL/.well-known/oauth-protected-resource/mcp"`. That document names the authorization server `$PUBLIC_BASE_URL/api/auth`, whose metadata is at `$PUBLIC_BASE_URL/.well-known/oauth-authorization-server/api/auth`.

2. Register a client dynamically. Keep `client_id` from the 201 response.

   ```bash
   REDIRECT='cursor://anysphere.cursor-mcp/oauth/callback'
   curl -s -H 'Content-Type: application/json' "$PUBLIC_BASE_URL/api/auth/oauth2/register" -d "{
     \"client_name\":\"My IDE\",\"redirect_uris\":[\"$REDIRECT\"],
     \"grant_types\":[\"authorization_code\",\"refresh_token\"],\"response_types\":[\"code\"],
     \"token_endpoint_auth_method\":\"none\",\"scope\":\"whatsapp offline_access\"}"
   ```

3. Authorize with PKCE (S256).

   ```bash
   VER=$(openssl rand -base64 48 | tr '+/' '-_' | tr -d '=\n')
   CH=$(printf '%s' "$VER" | openssl dgst -sha256 -binary | base64 | tr '+/' '-_' | tr -d '=\n')
   ENC() { node -e 'process.stdout.write(encodeURIComponent(process.argv[1]))' "$1"; }
   AUTH="$PUBLIC_BASE_URL/api/auth/oauth2/authorize?response_type=code&client_id=$CID&redirect_uri=$(ENC "$REDIRECT")&scope=whatsapp%20offline_access&state=xyz&code_challenge=$CH&code_challenge_method=S256&resource=$(ENC "$PUBLIC_BASE_URL/mcp")"
   curl -s -D - -o /dev/null "$AUTH" | grep -i '^location'
   ```

   Without an operator session, the redirect goes to `/sign-in?<signed query>`. The sign-in button posts `{"provider":"github","callbackURL":"/sign-in","oauth_query":"<query>"}` to `/api/auth/sign-in/social` with an `Origin` header, and the JSON `url` in the answer is the GitHub authorize URL. A local run stops at that URL.

4. With the operator cookie, the same `$AUTH` URL redirects to `/consent?<signed query>`. `GET` that page with the cookie: it shows the client name, the client ID, the redirect URI, and the scopes.

5. Approve as the page's button does. Better Auth refuses a cookie POST without an `Origin` header, so send one as a browser does.

   ```bash
   Q='<the query string after /consent?>'
   curl -s -H 'Content-Type: application/json' -H "Origin: $PUBLIC_BASE_URL" -H "Cookie: $(cat "$RUN/cookie.txt")" \
     "$PUBLIC_BASE_URL/api/auth/oauth2/consent" \
     --data-binary "$(node -e 'process.stdout.write(JSON.stringify({accept:true,oauth_query:process.argv[1]}))' "$Q")"
   ```

   The JSON `url` in the answer is the client redirect with `code`, `state`, and `iss`.

6. Exchange the code. The answer has `access_token`, a JWT whose audience is `$PUBLIC_BASE_URL/mcp`, and a `refresh_token` because the request asked for `offline_access`.

   ```bash
   curl -s "$PUBLIC_BASE_URL/api/auth/oauth2/token" -d grant_type=authorization_code -d "code=$CODE" \
     -d "client_id=$CID" --data-urlencode "redirect_uri=$REDIRECT" -d "code_verifier=$VER" \
     --data-urlencode "resource=$PUBLIC_BASE_URL/mcp"
   ```

7. Refresh with `grant_type=refresh_token`, the `refresh_token`, the `client_id`, and the `resource`. Each refresh returns a new refresh token.

A client with a client ID metadata document uses its HTTPS URL as `client_id` in step 3 and skips step 2.

## Role: headless application

1. Run the [operator sign-in](#operator-sign-in) once per data directory.
2. Register a client on the server host with the server's environment: `npm run register-client -- --name "My service"`. It prints `client_id=` and `client_secret=` once; keep them in a file only you can read.
3. Request a token as the README shows, then call the tools with `mcp`.

   ```bash
   curl -u "$CLIENT_ID:$CLIENT_SECRET" "$PUBLIC_BASE_URL/api/auth/oauth2/token" \
     -d grant_type=client_credentials -d scope=whatsapp --data-urlencode "resource=$PUBLIC_BASE_URL/mcp"
   ```

Each client IP can make 20 token requests and 5 registrations per minute (REQ-AUTH-012). Every local `curl` comes from the same address, so a run that passes those counts gets 429 for up to a minute.

## Tool calls safe while no phone is linked

```json
{"name":"get_status","arguments":{}}
{"name":"pair","arguments":{"method":"qr"}}
{"name":"pull_events","arguments":{"after":0,"limit":100}}
{"name":"pull_events","arguments":{"after":17,"wait_ms":20000}}
{"name":"list_chats","arguments":{}}
{"name":"send_message","arguments":{"to":"120363000000000000@g.us","idempotency_key":"k1","content":{"type":"text","text":"hi"}}}
```

- `pair` with `method: "qr"` restarts QR pairing and records `connection` events, so it wakes a waiting `pull_events` call.
- While unlinked, a write that passes its checks returns `not_paired` and sends nothing. A write whose target is not stored returns `unknown_message` first (DEC-018).

## Restart and stop

```bash
kill -TERM "$(cat "$RUN/server.pid")"    # npm forwards the signal to node
lsof -iTCP:$PORT -sTCP:LISTEN            # no output once the server has stopped
```

The server logs `"msg":"shutting down"`, then `state: "closed"`, and exits in under a second. An open long poll ends early; the client resumes with the cursor it held. To restart, run step 3 of the launch again with the same `DATA_DIR`. Stopping deletes nothing.

## Evidence

Keep each run's evidence in `$RUN`: the server log in `logs/`, raw HTTP responses in `http/`, and a run log of every command with a UTC timestamp. Write tokens, client secrets, codes, cookies, and QR strings as `<redacted>` in the run log. Raw responses keep token values, so never commit or share them.
