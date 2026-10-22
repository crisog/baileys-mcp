import { APIError } from 'better-call';
import { verifyOAuthQueryParams } from '@better-auth/oauth-provider';

import type { Auth } from './auth.ts';

import { SIGN_IN_PATH, AUTH_BASE_PATH } from './auth.ts';

// Sends the signed authorization query along, so Better Auth resumes the authorization after GitHub sign-in
const SIGN_IN_SCRIPT = `
document.querySelector('button').addEventListener('click', async () => {
  const body = { provider: 'github', callbackURL: '${SIGN_IN_PATH}' };
  if (location.search) {
    body.oauth_query = location.search.slice(1);
  }
  const response = await fetch('${AUTH_BASE_PATH}/sign-in/social', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  });
  if (!response.ok) {
    document.querySelector('output').textContent = 'Sign-in failed. Reload the page and try again.';
    return;
  }
  location.href = (await response.json()).url;
});
`;

const CONSENT_SCRIPT = `
for (const button of document.querySelectorAll('button')) {
  button.addEventListener('click', async () => {
    const response = await fetch('${AUTH_BASE_PATH}/oauth2/consent', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ accept: button.value === 'approve', oauth_query: location.search.slice(1) })
    });
    if (!response.ok) {
      document.querySelector('output').textContent = 'The decision was not saved. Restart the authorization from the client.';
      return;
    }
    location.href = (await response.json()).url;
  });
}
`;

export async function renderSignInPage(request: Request, auth: Auth): Promise<Response> {
  const isAuthorizing = new URL(request.url).search !== '';
  const session = await auth.api.getSession({ headers: request.headers });
  if (session !== null && !isAuthorizing) {
    return htmlResponse(200, page('Signed in', '<p>You are signed in as the operator.</p>'));
  }
  const body = `<p>Sign in with the operator's GitHub account.</p>
<button type="button">Sign in with GitHub</button>
<output></output>
<script>${SIGN_IN_SCRIPT}</script>`;
  return htmlResponse(200, page('Sign in', body));
}

export async function renderConsentPage(request: Request, auth: Auth): Promise<Response> {
  const query = new URL(request.url).search.slice(1);
  const { secret } = await auth.$context;
  if (!(await verifyOAuthQueryParams(query, secret))) {
    return htmlResponse(400, page('Invalid request', '<p>This consent link is invalid or has expired.</p>'));
  }
  const params = new URLSearchParams(query);
  const clientId = params.get('client_id');
  const redirectUri = params.get('redirect_uri');
  // The authorize endpoint rejects a request without either one before it signs the query
  if (clientId === null || redirectUri === null) {
    throw new Error('A verified consent query has no client_id or redirect_uri');
  }

  const clientName = await findClientName({ auth, clientId, headers: request.headers });
  if (clientName === null) {
    return htmlResponse(403, page('Cannot authorize', '<p>Sign in again from the client.</p>'));
  }

  let scopeItems = '';
  const scope = params.get('scope');
  if (scope !== null) {
    for (const scopeName of scope.split(' ')) {
      scopeItems += `<li>${escapeHtml(scopeName)}</li>`;
    }
  }
  const body = `<p><strong>${escapeHtml(clientName)}</strong> asks for access to this WhatsApp account.</p>
<p>Client ID: <code>${escapeHtml(clientId)}</code></p>
<p>Redirect URI: <code>${escapeHtml(redirectUri)}</code></p>
<p>Requested scopes:</p>
<ul>${scopeItems}</ul>
<button type="button" value="approve">Approve</button>
<button type="button" value="deny">Deny</button>
<output></output>
<script>${CONSENT_SCRIPT}</script>`;
  return htmlResponse(200, page('Authorize client', body));
}

type FindClientNameParams = {
  auth: Auth;
  clientId: string;
  headers: Headers;
};

// Returns null when the client is unknown or disabled, or when the visitor has no operator session
async function findClientName({ auth, clientId, headers }: FindClientNameParams): Promise<string | null> {
  try {
    const client = await auth.api.getOAuthClientPublic({ query: { client_id: clientId }, headers });
    if (client.client_name) {
      return client.client_name;
    }
    return client.client_id;
  } catch (error) {
    if (error instanceof APIError) {
      return null;
    }
    throw error;
  }
}

function page(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)} - baileys-mcp</title>
</head>
<body>
<h1>${escapeHtml(title)}</h1>
${body}
</body>
</html>`;
}

function htmlResponse(status: number, html: string): Response {
  return new Response(html, {
    status,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      // A framed consent page lets another site trick the operator into approving a client
      'content-security-policy': "frame-ancestors 'none'"
    }
  });
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}
