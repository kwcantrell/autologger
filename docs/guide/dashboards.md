---
title: Dashboards
section: guide
order: 40
description: Session stats from a declarative spec — event counts, talk time, topic timelines and custom numbers.
---

# Dashboards

A dashboard is a declarative JSON spec: stat tiles, bar, line and pie charts, tables, timelines and
Markdown. Agents build one from a sentence, and nothing in a spec ever runs as code.

## Build a dashboard with an agent

Dashboards are made by agents connected over MCP. Ask for what you want to see:

> Build a dashboard for this session with event counts by button, talk time per speaker and a
> timeline of the chapters.

- With the `autologger` plugin, the
  [session-dashboard skill](/docs/agents/plugins#autologger) designs and saves it.
- Without the plugin, any MCP client can use the server's `build_dashboard` prompt, or the
  `dashboards_save` tool.

Agents can preview the data behind a widget before they save it. If a session has no dashboard
yet, the Dashboards tab links to **Connect an agent**.

## View dashboards

The **Dashboards** tab shows a session's dashboards; with more than one, pick it from the row of
dashboard names (or focus the row and use the left and right arrow keys). Dashboards an agent made
carry an **agent** badge.

Live widgets are re-computed each time you open the dashboard, so counts stay current as you log
more events or the transcript changes.

## What a dashboard can show

| Widget   | Shows                                          |
| -------- | ---------------------------------------------- |
| stat     | One number, with an optional unit and caption. |
| bar      | A bar chart, vertical or horizontal.           |
| line     | A line chart.                                  |
| pie      | A pie chart.                                   |
| table    | Rows with chosen columns.                      |
| timeline | Items placed on the session's time axis.       |
| markdown | Text. Rendered without HTML.                   |

Each widget spans one to four columns of a four-column grid. Data widgets take rows the agent
computed, or a live query:

| Live query         | Rows                                                                        |
| ------------------ | --------------------------------------------------------------------------- |
| events_by_category | Events per button, with the button colour.                                  |
| events_over_time   | Events per button in time buckets.                                          |
| speaker_talk_time  | Seconds and turns per speaker.                                              |
| topics             | Topics with start, duration, level and summary.                             |
| events             | Logged events, optionally only some buttons.                                |
| summary_stats      | Events, topics, speakers, words, audio and speech length, words per minute. |
| category_count     | The number of events in the buttons you name.                               |

Values can be formatted as a duration, minutes, a number or a percentage. A widget can show a short
message, or hide itself, when its query has no rows, so one layout works across sessions with and
without a transcript.

## Rename, edit or delete a dashboard

With write access to the show, the Dashboards tab offers:

- **Rename** to change the title.
- **Edit JSON** to edit the spec by hand. Saving replaces the whole spec; invalid fields are named
  with their path.
- **Delete** to remove the dashboard.

Saves and deletes, by you or by an agent, are in the change log and can be undone; see
[Changes and undo](/docs/guide/changes-and-undo).

## Related

- [Example prompts](/docs/agents/example-prompts#dashboards)
- [Topics](/docs/guide/topics): the chapters a topic timeline draws.
