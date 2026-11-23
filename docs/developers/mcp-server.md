---
title: MCP server
section: developers
order: 10
description: The MCP endpoint, how Claude Code and claude.ai connect, tokens, and the OAuth endpoints for client authors.
---

AutoLogger never calls an LLM itself. Agents — Claude Code, claude.ai, Claude Desktop or any
MCP client — connect to the MCP endpoint and act **as the user who authorised them**, with that
user's access. Every write applies immediately, is attributed to the client in the session's
change log, and can be undone from the session's **Agents** tab.

- Endpoint: `<PUBLIC_URL>/mcp` (Streamable HTTP, stateless, `POST` only)
- Auth: `Authorization: Bearer <token>` — a personal access token (`alp_…`) or an OAuth access
  token (`alo_…`)
- Tools are generated from the ops registry: every op exposed on the `mcp` surface becomes a tool
  named with `_` instead of `.` (`events.create` → `events_create`). The server also sends
  usage instructions and three prompts: `generate_topics`, `build_dashboard`, `update_show_wiki`.

For a user's walk-through, see [Connecting agents](/docs/agents/connecting-agents). How ops become
tools is in [Architecture](/docs/developers/architecture#the-ops-registry-the-core-idea).

## Claude Code (personal access token)

1. In AutoLogger open **Settings › Agents** and create a personal access token. Copy it —
   it is shown once.
2. Add the server:

   ```sh
   claude mcp add --transport http autologger https://autologger.example.com/mcp \
     --header "Authorization: Bearer alp_…"
   ```

   Add `--scope user` to make it available in every project.
3. In Claude Code, `/mcp` should list `autologger` as connected. Try “list my AutoLogger sessions”.

Claude Code can also use OAuth instead of a token: run
`claude mcp add --transport http autologger https://autologger.example.com/mcp` without the header,
then `/mcp` → **Authenticate**; a browser window opens on the AutoLogger consent page.

## claude.ai and Claude Desktop (OAuth)

1. **Settings → Connectors → Add custom connector**.
2. Name it “AutoLogger” and enter `https://autologger.example.com/mcp`. Leave the OAuth client
   fields empty — the client registers itself (dynamic client registration).
3. Click **Connect**. You are sent to AutoLogger; sign in if needed and choose **Allow** on the
   consent screen. The connector then appears under **Settings › Agents** as a connected app.

Accounts waiting for administrator approval cannot authorise agents.

## Token management

**Settings › Agents** lists personal access tokens and connected OAuth apps (one row per
app authorisation) with when they were created and last used. Revoking a token stops it at once;
disconnecting an OAuth app revokes all of its access and refresh tokens.

| Token                 | Prefix | Lifetime                         |
| --------------------- | ------ | -------------------------------- |
| Personal access token | `alp_` | no expiry unless set at creation |
| OAuth access token    | `alo_` | 1 hour                           |
| OAuth refresh token   | `alr_` | 30 days, rotated on every use    |

Only SHA-256 hashes of tokens are stored. Refresh tokens rotate: each refresh returns a new pair,
and presenting an already-used refresh token is treated as theft and revokes the whole grant.

## OAuth endpoints (for client authors)

|                               |                                                                                          |
| ----------------------------- | ---------------------------------------------------------------------------------------- |
| Protected resource metadata   | `GET /.well-known/oauth-protected-resource` (also `/…/mcp`)                              |
| Authorization server metadata | `GET /.well-known/oauth-authorization-server`                                            |
| Dynamic client registration   | `POST /oauth/register` (public clients, `token_endpoint_auth_method: none`)              |
| Authorization                 | `GET /oauth/authorize` — `response_type=code`, PKCE `S256` required, optional `resource` |
| Token                         | `POST /oauth/token` — `authorization_code`, `refresh_token`; form or JSON body           |
| Revocation                    | `POST /oauth/revoke` (RFC 7009)                                                          |

The only scope is `autologger`. Redirect URIs must be `https://`, `http://localhost` /
`127.0.0.1` (any port at request time), or a private-use scheme such as `claude://`. Authorization
codes are single-use and expire after 60 seconds. An unauthenticated request to `/mcp` answers
`401` with `WWW-Authenticate: Bearer resource_metadata="<PUBLIC_URL>/.well-known/oauth-protected-resource"`,
which is how clients discover the authorization server.

Tokens also work against the plain HTTP API: `POST /api/rpc/<op>` with the bearer header calls
the same ops (MCP surface only).

## Testing locally

With the server running (`DEV_LOGIN=1`):

```sh
cd apps/server
node scripts/mcp-smoke.ts http://localhost:18081           # PAT + full OAuth flow
node scripts/mcp-sdk-client.ts http://localhost:18081 alp_…  # official SDK client
npx vitest run src/mcp                                     # PKCE / redirect / rotation rules
```
