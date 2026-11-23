---
title: Connecting agents
section: agents
order: 10
description: Connect Claude Code, claude.ai or any MCP client to AutoLogger, with OAuth sign-in or a personal access token.
---

# Connecting agents

AutoLogger never calls a model itself. Claude Code, claude.ai or any MCP client connects as you,
with your access. Its changes apply right away, and each one carries the name of the client that
made it, so you can see and undo it from the session's Agents tab (wiki and event-button changes
from the show's Changes page).

## What an agent can do

An agent gets the same access you have: it can read and change every show you can open, and nothing
more. Over MCP it can read sessions, transcripts and the log, search, and write events, topics,
transcript fixes, dashboards and wiki pages. It can also import from YouTube, make video
compilations, and create teams and shows.

Some things stay in the web app: deleting sessions and shows, managing members, Companion devices
and tokens.

Every write is recorded in the change log under your name plus the client's name; see
[Changes and undo](/docs/guide/changes-and-undo).

## Find your server's MCP address

Open **Settings › Agents**. Under **Connect an agent**, **MCP server URL** is your server's address
plus `/mcp`, for example `https://autologger.example.com/mcp`, with a copy button. The same card
has the ready-made Claude Code command. A session's **Agents** tab shows both too.

## Connect Claude Code

Run this in a terminal, with your server's address:

```sh
claude mcp add --transport http autologger https://autologger.example.com/mcp
```

Add `--scope user` to make it available in every project. Then, inside Claude Code, run `/mcp`,
choose `autologger` and authenticate. Your browser opens AutoLogger's consent page; sign in if
needed and choose **Approve**.

Try "list my AutoLogger sessions" to check it works.

The `autologger` plugin sets up the same connection and adds ready-made skills; see
[Plugins](/docs/agents/plugins).

## Connect claude.ai or Claude Desktop

1. In claude.ai or Claude Desktop, add a custom connector (under **Settings › Connectors**).
2. Name it "AutoLogger" and enter your MCP server URL. Leave the OAuth client fields empty: the
   client registers itself.
3. Connect. You are sent to AutoLogger; sign in if needed and choose **Approve**.

The connector then appears in **Settings › Agents** as a connected app.

## Connect other MCP clients

AutoLogger's MCP server speaks Streamable HTTP at `/mcp`. Clients that support MCP's OAuth sign-in
discover it on their own, the way Claude does. Clients that don't can send a personal access token
as a header:

```text
Authorization: Bearer alp_…
```

For Claude Code, that is:

```sh
claude mcp add --transport http autologger https://autologger.example.com/mcp \
  --header "Authorization: Bearer alp_…"
```

The server also offers three prompts any client can use without a plugin: `generate_topics`,
`build_dashboard` and `update_show_wiki`. Endpoints, scopes and token formats for client authors are
in [MCP server](/docs/developers/mcp-server).

## OAuth sign-in or personal access token

|                | OAuth sign-in                               | Personal access token                 |
| -------------- | ------------------------------------------- | ------------------------------------- |
| Best for       | Claude Code, claude.ai, Claude Desktop      | Scripts, headless runs, other clients |
| How you get it | Approve in the browser when the client asks | Create it in **Settings › Agents**    |
| Starts with    | `alo_` (refreshed by the client)            | `alp_`                                |
| Expiry         | The client keeps itself signed in           | 30 days, 90 days, 1 year or never     |
| Shows as       | Connected app                               | Token                                 |

Accounts still waiting for approval can't connect agents.

## Create a personal access token

1. In **Settings › Agents › New personal access token**, enter a **Name** (what uses it, so you can
   tell tokens apart) and choose when it **Expires**.
2. Choose **Create token** and copy it. It is shown only once; treat it like a password.

The [import helper](/docs/guide/importing-from-youtube#import-from-your-own-computer) uses a
personal access token too.

## Revoke access

**Settings › Agents › Connected agents and tokens** lists your tokens and connected apps with when
they were created and last used. **Revoke** a token or **Disconnect** an app to end its access at
once.

## Related

- [Plugins](/docs/agents/plugins): ready-made skills for Claude Code.
- [Example prompts](/docs/agents/example-prompts)
- [MCP server](/docs/developers/mcp-server): tools, OAuth endpoints and token details.
