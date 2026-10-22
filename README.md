# baileys-mcp

An [MCP](https://modelcontextprotocol.io) server that gives AI agents access to a WhatsApp account through [Baileys](https://github.com/WhiskeySockets/Baileys), served over Streamable HTTP.

The server answers MCP initialization at `/mcp`. It has no tools, no WhatsApp connection, and no authentication yet, so do not expose it to the internet.

Baileys is an unofficial WhatsApp Web client. WhatsApp can change its protocol or restrict an account that uses it, so link a dedicated number.

## Run

```bash
nvm use
npm ci
npm start
```

`PORT` sets the listen port. The default is `3000`.

## Develop

`npm run verify` runs every check that CI runs.

## License

[MIT](LICENSE)
