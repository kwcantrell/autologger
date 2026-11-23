---
title: Plugins
section: agents
order: 20
description: The AutoLogger plugin marketplace for Claude Code — what each plugin and skill does, and how to install them.
---

# Plugins

The AutoLogger plugin marketplace has ready-made Claude Code skills for working with your sessions:
chaptering, logging moments, dashboards, the show wiki, briefs, imports and questions. A skill is a
set of instructions Claude follows when your request matches it, using AutoLogger's MCP tools.

The marketplace lives at
[kwcantrell/autologger-marketplace](https://github.com/kwcantrell/autologger-marketplace).

## Install

```sh
claude plugin marketplace add kwcantrell/autologger-marketplace
claude plugin install autologger@autologger
claude plugin install autologger-ask@autologger
```

Inside Claude Code the same works with `/plugin marketplace add …` and `/plugin install …`.

When you install `autologger`, Claude Code asks for your **AutoLogger URL**: your server's address
without a trailing slash, such as `https://autologger.example.com`. The plugin connects to
`<your URL>/mcp` and signs in through your browser the first time; run `/mcp` to sign in. If you
already added the server by hand, see [Connecting agents](/docs/agents/connecting-agents).

## Use a skill

Ask in plain words, such as "chapter yesterday's episode", and Claude picks the matching skill. Or
run one by name, such as `/autologger:session-topics`. Everything a skill writes is attributed to
you plus the client name, and can be undone from the session's Agents tab. Wiki pages and event
buttons belong to the show, not a session: undo those from the show's **Changes** page.

## autologger

For producers and operators.

| Skill                            | What it does                                                                                                                                         |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/autologger:import-videos`      | Imports a YouTube video or playlist into a show, one session per video, then optionally annotates each one. Also sets up the team's YouTube sign-in. |
| `/autologger:transcript-cleanup` | Fixes systematic transcription mistakes (misheard names and terms, numbers, spoken math), names speakers and notes what changed.                     |
| `/autologger:session-topics`     | Generates or rewrites a session's topics (chapters) from its transcript.                                                                             |
| `/autologger:log-moments`        | Finds moments you describe (laughs, ad reads, guest intros, quotable lines) and logs them with the show's event buttons.                             |
| `/autologger:session-dashboard`  | Designs and saves a dashboard for a session: event counts, talk time, topic timeline, custom stats.                                                  |
| `/autologger:show-wiki`          | Writes a session recap and keeps the people, running-bit and topic pages up to date.                                                                 |
| `/autologger:detailed-wiki`      | Builds a detailed, cited wiki for a whole show: a recap per session, then host, guest, bit, topic and hub pages.                                     |
| `/autologger:find-moments`       | Read-only. Answers "when did we talk about X" across sessions with titles and timecodes.                                                             |
| `/autologger:session-brief`      | Read-only. Writes an editor's or producer's brief in chat: rundown, highlights, clip candidates, problems, follow-ups.                               |
| `/autologger:report-issue`       | Files a GitHub issue when a tool or skill got in the way, or for work left for later.                                                                |

It also has the `session-recap` agent, which `detailed-wiki` runs on many sessions in parallel.

## autologger-ask

Questions and video compilations. Needs the `autologger` plugin, whose connection it uses.

| Skill                           | What it does                                                                                                                                                            |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/autologger-ask:ask`           | Answers a question about a show with timecode ranges per session, saves it as a cited question page in the wiki, and offers a compilation for YouTube-sourced sessions. |
| `/autologger-ask:compile-clips` | Turns ranges, or a question page's citations, into one MP4 built by the server from the YouTube sources.                                                                |

It also has the `session-scan` agent, which reads one session end to end for a question; `ask` runs
it on many sessions in parallel when search misses paraphrases.

## Plugins for contributors

The marketplace also has `autologger-dev` and `autologger-contribute`, for people changing
AutoLogger itself: implementation guides, a reviewer agent, a guided first tour and the pull
request workflow. See [Contributing](/docs/developers/contributing).

## Without the plugins

Any MCP client can use AutoLogger's tools directly. The server describes each tool for agents, and
offers three prompts: `generate_topics`, `build_dashboard` and `update_show_wiki`.

## Related

- [Example prompts](/docs/agents/example-prompts): what to ask, by task.
- [Connecting agents](/docs/agents/connecting-agents)
