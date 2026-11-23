---
title: Example prompts
section: agents
order: 30
description: Realistic things to ask an agent connected to AutoLogger, grouped by task, with the skill or tool each one uses.
---

# Example prompts

Things to ask Claude once it is [connected](/docs/agents/connecting-agents), grouped by task. Each
names the [plugin skill](/docs/agents/plugins) that picks it up, or the MCP tools an agent without
the plugins would use. Name the show or session the way you would to a colleague; the agent looks
up the ids.

Everything an agent writes shows in the session's Agents tab and can be undone; see
[Changes and undo](/docs/guide/changes-and-undo).

## Setup

| Prompt                                                                                             | Uses                                 |
| -------------------------------------------------------------------------------------------------- | ------------------------------------ |
| "Create a show called Morning Coffee in my team, with buttons for Laugh, Ad read and Guest intro." | `shows_create`, `categories_save`    |
| "Add a dropdown button Camera with options A, B and C to Morning Coffee."                          | `categories_list`, `categories_save` |
| "Add Dana Reyes and Morning Coffee as key terms for the show."                                     | `shows_update`                       |

## Import

| Prompt                                                                                                         | Uses                        |
| -------------------------------------------------------------------------------------------------------------- | --------------------------- |
| "Import this playlist into Morning Coffee, oldest video as episode 1: https://www.youtube.com/playlist?list=…" | `/autologger:import-videos` |
| "Import this video into a new session and add the guest's name as a key term: https://youtu.be/…"              | `/autologger:import-videos` |
| "Is the playlist import finished yet?"                                                                         | `jobs_list`                 |
| "YouTube is blocking imports. Help me set up our team's YouTube sign-in."                                      | `/autologger:import-videos` |

## Transcripts

| Prompt                                                                                              | Uses                             |
| --------------------------------------------------------------------------------------------------- | -------------------------------- |
| "Clean up the transcript of episode 12: it keeps writing 'doctor' for 'dr', and Speaker 1 is Dana." | `/autologger:transcript-cleanup` |
| "Rename Speaker 2 to Tom in the last session, but only after the first five minutes."               | `transcript_renameSpeaker`       |
| "Import this SRT file as the transcript of today's session, replacing what's there."                | `transcript_import`              |
| "Apply the show's replacement rules to every session transcribed before we added them."             | `transcript_replace`             |

## Topics

| Prompt                                                                  | Uses                         |
| ----------------------------------------------------------------------- | ---------------------------- |
| "Chapter yesterday's episode."                                          | `/autologger:session-topics` |
| "Redo the topics of episode 8 with only major segments, no sub-topics." | `/autologger:session-topics` |
| "Add short summaries to the topics of this session."                    | `topics_update`              |

## Logging moments

| Prompt                                                                             | Uses                               |
| ---------------------------------------------------------------------------------- | ---------------------------------- |
| "Log every big laugh and every ad read in episode 14."                             | `/autologger:log-moments`          |
| "Mark the guest intros across the last five sessions with the Guest intro button." | `/autologger:log-moments`          |
| "Move the events I logged too late in this session back by three seconds."         | `events_list`, `events_updateMany` |

## Dashboards

| Prompt                                                                                                | Uses                            |
| ----------------------------------------------------------------------------------------------------- | ------------------------------- |
| "Build a dashboard for this session: events by button, talk time per speaker and a chapter timeline." | `/autologger:session-dashboard` |
| "Add a stat with the number of Key insight events to this session's dashboard."                       | `dashboards_updateWidgets`      |

## Wiki

| Prompt                                                                          | Uses                        |
| ------------------------------------------------------------------------------- | --------------------------- |
| "Write the recap for episode 21 and update the wiki pages of the people in it." | `/autologger:show-wiki`     |
| "Build a detailed wiki for the whole show from all its sessions."               | `/autologger:detailed-wiki` |
| "Check the wiki for broken links and citations and fix them."                   | `wiki_lint`, `wiki_patch`   |

## Ask and compile

| Prompt                                                               | Uses                            |
| -------------------------------------------------------------------- | ------------------------------- |
| "What has Tom said about pricing across the show?"                   | `/autologger-ask:ask`           |
| "When did Dana first mention her dog?"                               | `/autologger:find-moments`      |
| "Make a video of every time they talked about the dog."              | `/autologger-ask:compile-clips` |
| "Turn the clips on the wiki's pricing question page into one video." | `/autologger-ask:compile-clips` |

## Briefs and search

| Prompt                                                              | Uses                        |
| ------------------------------------------------------------------- | --------------------------- |
| "Write an editor's brief for today's session with clip candidates." | `/autologger:session-brief` |
| "Which episodes had an audio issue logged?"                         | `/autologger:find-moments`  |
| "Draft show notes for episode 9 from its topics."                   | `/autologger:session-brief` |

## Undo and review

| Prompt                                       | Uses                                  |
| -------------------------------------------- | ------------------------------------- |
| "What did agents change in this show today?" | `changes_list`                        |
| "Undo the speaker rename you just did."      | `changes_list`, `changes_revertGroup` |

You can also undo anything yourself from the Agents tab or the Changes page.

## When something gets in the way

| Prompt                                            | Uses                       |
| ------------------------------------------------- | -------------------------- |
| "That tool kept failing. File an issue about it." | `/autologger:report-issue` |
