# baileys-mcp

An [MCP](https://modelcontextprotocol.io) server that gives AI agents access to a WhatsApp account through [Baileys](https://github.com/WhiskeySockets/Baileys), served over Streamable HTTP.

The server serves MCP at `/mcp` behind OAuth. It is its own authorization server: MCP clients discover it from the `/mcp` URL, and the operator signs in with GitHub and approves each client. The tools read the connection status, pair the account, list chats and stored messages, pull inbound events, and download media.

Baileys is an unofficial WhatsApp Web client. WhatsApp can change its protocol or restrict an account that uses it, so link a dedicated number.

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

`npm run verify` runs every check that CI runs.

## License

[MIT](LICENSE)
