---
title: Knowledge graph
section: developers
order: 35
description: How AutoLogger turns sessions, wiki pages, citations, topics and events into a queryable knowledge graph of entities and clip-ready moments — the formats considered, the model, the ops and the export files.
---

# Knowledge graph

A show wiki written by agents (recaps, people, recurring bits, topics — see [Wiki](/docs/guide/wiki))
already _is_ a knowledge graph: pages are entities, `[[links]]` are relations, aliases are alternate
names, and every citation ties a statement to a range of a session. AutoLogger exposes that graph
directly, so agents can **find moments and clips** ("every time Carly and Pig Talk come up") and
other systems can load it (graph databases, vector indexes), without a second store that could
drift from the wiki.

## The model

Everything is a projection of stored data; nothing new is persisted.

| Graph element                                         | Comes from                                                                                          |
| ----------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| **Show** node                                         | the show                                                                                            |
| **Episode** nodes                                     | sessions (episode order: episode numbers when every session has one, else episode date; then title) |
| **Entity** nodes: Person, Bit, Topic, Recap, Question | live wiki pages by kind, with aliases and the first paragraph as summary                            |
| `PART_OF` episode → show                              | sessions                                                                                            |
| `RECAP_OF` recap → episode                            | a session page's `sessionId`                                                                        |
| `LINKS_TO` page → page                                | `[[links]]` resolved through titles and aliases                                                     |
| `APPEARS_IN` entity → episode (with a count)          | citations about the entity in that episode                                                          |
| **Moments**                                           | wiki citations, topics, events (and transcript lines when searching)                                |

### Moments — the unit of search

A **moment** is a clip-ready range of a session: `sessionId`, `startSec`, `endSec` (seconds from
the session start), a title, a text saying what happens, and the **entities** it is about.

- **Citation moments** are the richest. Each citation on a wiki page becomes one; its text is the
  block that cites it (the paragraph, list item or table row, read as plain text), its headings are
  where it sits on the page, and its entities are the citing page plus every page `[[linked]]` in
  the same block. So "- [[Carly]] reads a letter about a moose [EP_01 00:10:00](…)" on the
  _Pig Talk_ page is a moment about Pig Talk and Carly.
  A block with several citations describes each by its own sentence. A list item is one story,
  so each of its citations (up to three) is tagged with every page the item links; in a longer
  item (a list of dates or facts) and in a paragraph only the citing sentence's links count. A table row is read cell by cell: a citation is tagged with the links in its own cell and in the cells
  before it (the row's subject), so an episode-guide row is not a moment about every segment
  listed in its last column.
- **Topic moments** are chapters (title — summary, start, end).
- **Event moments** are logged events (category, message; no end). "Note" events (editorial
  notes such as "speakers named by hand") are found by query but never tagged with entities.
- **Transcript moments** are transcript lines, only when searching (by query or entity name).

Topics, events and transcript lines carry no links, so their entities are found by whole-word,
case-insensitive matches of page titles and aliases (3+ characters) in their text. Aliases matter:
"Smut dog" on Carly's page makes an event that says "Smut dog strikes again" a moment about Carly.

The block parser lives in `packages/contract/src/knowledge.ts` (`wikiBlocks`, `wikiSections`,
`plainText`), the ops in `apps/server/src/ops/graph.ts`.

## Ops (HTTP RPC and MCP)

| Op               | MCP tool         | What it does                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| ---------------- | ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `moments.search` | `moments_search` | Find moments by `query` (full text), `entities` (titles, aliases or page ids — all must match), `sessionId` and `kinds`. Ranked with a query (page titles and headings weigh most; a query no moment matches in full falls back to at least half its words), else in episode order. `mergeGapSec` also returns `clips`: the page's moments merged per session, at most `maxClipSec` long (whole-segment topics are dropped where tighter moments cover them) — ready for `compilations.create`; `clipsOnly` returns only those. `compact` (the MCP default) trims each moment to ids, times, 160 characters of text and entity titles. |
| `graph.entity`   | `graph_entity`   | One entity: kind, aliases, summary, moment count, the episodes it appears in (with its first moment in each) and related pages (links, backlinks, co-cited), strongest first.                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `graph.export`   | `graph_export`   | The graph as paged JSONL rows (`nodes`, `edges`, `moments`, `chunks`, or `all`) or one JSON-LD document.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |

## Export files

`GET /api/shows/<showId>/export/<file>` with a session cookie or a bearer token (PAT or OAuth):

| File            | Contents                                                                                                                                                                  | Use it for                                                                                             |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `graph.jsonld`  | schema.org JSON-LD: `PodcastSeries`, `PodcastEpisode`, `Person`, `CreativeWork`/`DefinedTerm` (+ `al:` types), `Clip` with `startOffset`/`endOffset`, `about`, `mentions` | linked-data tools, RDF stores (convert with any JSON-LD processor), interchange                        |
| `graph.jsonl`   | one row per line: `{"type":"node"                                                                                                                                         | "edge"                                                                                                 | "moment" | "chunk", …}` | property-graph databases (Neo4j, Kùzu, Memgraph), networkx, pandas |
| `moments.jsonl` | the moment rows only                                                                                                                                                      | a clip index; search or filter without the server                                                      |
| `chunks.jsonl`  | every wiki section: heading path, `context` ("Show › Page › Heading"), plain text, Markdown, citations, entities                                                          | vector indexes / RAG: embed `context + text`, keep citations as metadata so answers can point at audio |

## Formats considered

| Format                                                                   | Strengths                                                                                      | Weaknesses                                                                                                 | Decision                                                          |
| ------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| **Markdown wiki** (existing)                                             | Readable, editable by people and agents, revisions and undo, full-text search                  | Relations and time ranges are implicit in prose                                                            | Stays the source of truth; everything else is derived from it     |
| **JSON-LD (schema.org)**                                                 | Standard vocabulary (`PodcastEpisode`, `Clip`, `Person`), linked-data tooling, self-describing | Verbose; schema.org has no words for recurring bits, citations or co-occurrence; awkward to query directly | Export (`graph.jsonld`) with a small `al:` namespace for the gaps |
| **RDF / Turtle**                                                         | Formal semantics, SPARQL                                                                       | Heavy for agents; adds nothing JSON-LD can't be converted to                                               | Not built: convert `graph.jsonld` with a JSON-LD processor        |
| **Property graph (nodes/edges JSONL)**                                   | Maps 1:1 to graph databases and dataframes; edges carry properties (moment counts)             | No standard vocabulary                                                                                     | Export (`graph.jsonl`)                                            |
| **Moment index**                                                         | The thing agents actually want: time ranges with text and entities, compilable into clips      | Only as good as the wiki's citations                                                                       | Live op (`moments.search`) and export (`moments.jsonl`)           |
| **RAG chunks**                                                           | Drop-in for vector stores; each chunk says where it is                                         | Loses graph structure unless metadata is kept                                                              | Export (`chunks.jsonl`) with citations and entities as metadata   |
| **Typed claims** (subject–predicate–object with evidence and confidence) | Facts with explicit uncertainty                                                                | Needs agents to write structured blocks and a validator                                                    | Not built yet — tracked as a follow-up                            |

The deciding constraint: **one source of truth.** A hand-maintained graph next to the wiki drifts as
soon as a page is edited. Deriving every format from the wiki (plus topics and events) means a wiki
edit, revert or rename shows up in the graph on the next call, and quality work happens in one
place — the pages.

## What makes the graph good

The graph is only as good as the wiki. The [knowledge graph pipeline](/docs/agents/knowledge-graph)
describes how agents should write pages so that blocks make good moments: one claim per list item
or sentence with its own citation, `[[links]]` to every entity the claim is about, aliases for every
name a transcript or a person might use, and headings that say what a section is.
