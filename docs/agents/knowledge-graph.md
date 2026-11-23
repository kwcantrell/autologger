---
title: Knowledge graph pipeline
section: agents
order: 25
description: The step-by-step pipeline agents follow to turn a show's recordings into a searchable knowledge graph and wiki — and how to search it for moments and clips.
---

# Knowledge graph pipeline

The goal: an agent asked "find every time Carly and Pig Talk came up" (or "make a supercut of the
airport stories") answers in two or three tool calls with exact session ranges. That works when the
show wiki is written so that **every cited block is a good moment** — AutoLogger then serves the
wiki as a graph of entities and moments (see [Knowledge graph](/docs/developers/knowledge-graph)).

The pipeline has six stages. Stages 3 and 4 run per session in parallel; the rest run once per show.

## 1. Import

- Local files: `media_importFiles` (one session per file; pass `title`, `episode` and
  `episodeDate` from your manifest — the default episode counter follows upload order, not air
  order). YouTube: `media_importPlaylist` / `media_importYoutube`.
- Pass `transcribe: false` to `media_completeUploads` if conventions (stage 2) are not set yet;
  transcribe later with `media_retranscribe`.

## 2. Conventions — once, before any parallel work

Read **one** representative transcript and fix, in writing, what every later agent must use:

| Decide                                                                                                             | Where it goes                                                                                                       |
| ------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------- |
| Speaker roster: host(s), co-hosts, recurring voices, and labels for the rest ("Producer", "Crew", "Clip", "Music") | the brief for stage 3                                                                                               |
| Canonical names of recurring segments/bits and people, with the misspellings heard                                 | stage 5 page titles and aliases; `transcriptRules`                                                                  |
| Show-wide fixes: misheard show name, host name, site, sponsors                                                     | `shows_update` `transcriptRules` (apply to existing transcripts with `transcript_replace` without `rules`)          |
| Names said in every episode                                                                                        | `shows_update` `keyTerms` (guest names go on the session, not the show)                                             |
| Event buttons for this kind of show                                                                                | `categories_save` — for talk shows: Segment, Story, Funny moment, Quote, Clip played, Ad read, Plug, Callback, Note |

Parallel agents that each decide these for themselves produce inconsistent labels and spellings,
which split both search and the graph.

## 3. Per session — one read

One agent per few sessions; each reads the whole transcript **once** (`transcript_text`
`{format: "compact", stampEverySec: 0}`, ~30-minute pages) and then, from that read:

1. **Cleans** it (the `transcript-cleanup` skill): speakers per the roster, misheard names,
   words spilled across speaker changes.
2. **Chapters** it (`topics_replace`): specific titles (who/what) and a one-line summary each —
   topic summaries are matched against entity names, so name people and bits in them.
3. **Logs events** (`events_createMany`) with the show's buttons; put names in the message.
4. **Writes the recap** (`wiki_upsert` kind `session`) following the moment rules below.
5. **Writes notes** for stage 4: facts about recurring people and bits, with long-form citations.

## 4. Shared pages

Create a page only for a person, bit or topic that comes up in **two or more** sessions; fix all
titles before writing so writers can link each other's pages. Split writers so no two edit the
same page. Each page: what it is, a "By episode" list with one cited item per appearance, notable
moments, and every alias.

## Moment rules — how to write pages that search well

The graph reads each paragraph, list item and table row as a **block**; every citation in a block
becomes a moment described by that block's text and tagged with the page plus the pages linked in
the block.

- **One claim per block, with its own citation.** Prefer a list item per story, quote or
  appearance over a paragraph with five citations — five citations in one paragraph become five
  moments with the same description.
- **Link every entity the claim is about**, every time: `- [[Carly]] reads a [[Pig Talk]] letter
  about a moose [VAH_0006 00:20:00](/sessions/…?t=1200&to=1260)`. An unlinked name is invisible to
  entity search on that moment.
- **Always give a tight range** (`to=` / `@start-end`) — the stretch where that item is said,
  usually under ~2 minutes, never a whole segment. Moments without an end are merged into clips
  as a fixed-length point.
- **Depth on shared pages**: one list item per story, letter, headline or fact (not one per
  episode), each fact written once — by episode on segment pages, by theme on person and topic
  pages — with a short format summary on top.
- **Aliases on every page** for every _specific_ name the transcript or a person might use
  (nicknames, misspellings, "We're Wrong" for "You're Wrong"). Aliases also tag topics, events and
  transcript lines that mention them, so **no generic aliases**: no bare first names ("Tom",
  "Shane"), no common words or phrases ("the show", "the special", "Producer", "morons"). A topic
  page may keep topical keywords ("Airlines", "Smoking") — tagging those mentions is its job.
- **Headings say what a section is** ("Pig Talk letters", not "Part 2"): they travel with the
  moment and with RAG chunks.
- **Blocks stand alone**: start with the subject's name, not "he" or "this segment"; dates absolute.
- Mark uncertainty in the block itself ("spelling unconfirmed", "As of VAH_0016 …").

## 5. Verify

1. `wiki_lint` — no unresolved links, bad citations or orphans.
2. For each recurring entity, `graph_entity`: `momentCount` > 0, the `sessions` list matches the
   notes, `related` makes sense. Then count how many topic and event moments each entity tags
   (`graph_export {section: "moments"}`): an entity tagging a large share of them has a generic
   alias — remove it. An entity with 0 moments has no cited block linking it — fix the
   pages, not the search.
3. Spot-check `moments_search` with the questions users will ask (one entity, two entities, a
   phrase) and open a few `startSec`s in the transcript.

## 6. Search moments and clips

| Question                             | Calls                                                                                                              |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------ |
| Who/what is X, where does it appear? | `graph_entity {showId, entity: "X"}`                                                                               |
| Every moment about X                 | `moments_search {showId, entities: ["X"]}`                                                                         |
| Where X and Y come up together       | `moments_search {showId, entities: ["X", "Y"]}`                                                                    |
| A theme in anyone's words            | `moments_search {showId, query: "airport stories"}` (add `kinds` to narrow)                                        |
| Exact quote                          | `moments_search {showId, query: "\"never again\"", kinds: ["transcript"]}`                                         |
| A supercut                           | `moments_search {…, mergeGapSec: 20}` → pass `clips` (sessionId, startSec, endSec, label) to `compilations_create` |
| Cite it in an answer                 | `[label](/sessions/<sessionId>?t=<startSec>&to=<endSec>)`                                                          |

Whole-graph consumers (graph databases, vector stores) download
`/api/shows/<showId>/export/graph.jsonld`, `graph.jsonl`, `moments.jsonl` or `chunks.jsonl` with a
bearer token, or page through `graph_export` over MCP.
