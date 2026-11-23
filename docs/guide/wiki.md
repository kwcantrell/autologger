---
title: Wiki
section: guide
order: 50
description: A Markdown wiki per show — people, running bits, recaps and answered questions, linked and cited.
---

# Wiki

Every show keeps a Markdown wiki of people, recurring bits, session recaps and answered questions.
Pages link with `[[double brackets]]` and cite the exact range of a session they come from, so the
wiki doubles as a knowledge base you can check.

Open it with **Wiki** in the top bar. It shows the wiki of the show chosen in the top bar.

## Page kinds

| Kind        | Tab          | Used for                                            |
| ----------- | ------------ | --------------------------------------------------- |
| Person      | People       | Hosts, guests, recurring people.                    |
| Topic       | Topics       | Subjects that come up across sessions.              |
| Running bit | Running bits | Recurring jokes, segments and formats.              |
| Session     | Sessions     | The recap of one session.                           |
| Question    | Questions    | A question about the show, answered with citations. |

**Filter by title or alias** narrows the list in every tab.

## Create a page

Choose **New page**, pick a **Kind**, enter a **Title** (and the **Session**, for a session recap)
and choose **Create**. If the page can't be created because one like it already exists, the
dialog links to it with **Open that page**.

A session's recap is also one click away inside the session: the **Wiki** menu in its tab row
opens **Session recap page**, creating it if needed. The same menu lists the pages that cite the
session under **Cited in**.

## Edit a page

Choose **Edit**. You can change the **Title**, add **Aliases** (other names the page answers to),
and write the body under **Write**, with **Preview** to check it. Choose **Save** when you're done.

You need write access to the show to edit its wiki.

## Link pages

Write `[[Title]]` to link another page of the same show, or `[[Title|label]]` to show different
text. Titles and aliases both match; case and extra spaces are ignored. A page lists the pages that
link to it under **Linked from**.

## Cite a moment

A citation is a Markdown link to a range of a session, in seconds from the session start:

```md
[Dana on the dog](/sessions/ses_abc?t=754.2&to=811)
```

It shows as a chip with the session title and the time range. Selecting it opens the session and
plays just that range. The end (`to`) is optional.

Short forms do the same with less typing:

| Form                          | Where it works                             |
| ----------------------------- | ------------------------------------------ |
| `[label](@754.2-811)`         | On a session recap: cites its own session. |
| `[@754.2-811]`                | On a session recap, without a label.       |
| `[label](@ses_abc:754.2-811)` | On any page.                               |
| `[@ses_abc:754.2-811]`        | On any page, without a label.              |

The ids come from the session's address in your browser (`/sessions/ses_…`). Agents write
citations for you when they write recaps and answers.

## Recaps and question pages

Agents write most of the wiki:

- The [show-wiki skill](/docs/agents/plugins#autologger) writes a session recap and updates the
  people, bit and topic pages it mentions.
- The [detailed-wiki skill](/docs/agents/plugins#autologger) builds a detailed, cited wiki for a
  whole show.
- The [ask skill](/docs/agents/plugins#autologger-ask) saves each answered question as a Question
  page; see [Ask and compilations](/docs/guide/ask-and-compilations).

Without the plugins, any MCP client can use the server's `update_show_wiki` prompt.

Agents can also check the whole wiki for links to missing pages, pages nothing links to and broken
citations with the `wiki_lint` tool.

## History and restore

**History** lists every revision of a page with its author and time. Choose one to compare it with
the current page, then choose **Restore r…** (for example **Restore r3**) to bring it back.
Restoring saves a new revision, so nothing is lost.

## When two people edit at once

If someone else saves the page while you are editing it, saving shows **This page changed while
you were editing**:

- **Copy my text** puts your version on the clipboard.
- **Load latest version** loads their version into the editor and keeps your text above it to copy
  from.
- **Overwrite with my version** saves yours. Their revision stays in History.

## Delete a page

**Delete** removes the page from the wiki, search and links. Its revision history is kept, so the
delete can be undone from **Changes**: the wiki's **Changes** button opens the show's change log
filtered to wiki pages.
See [Changes and undo](/docs/guide/changes-and-undo).

## Make a video from a page

A page with citations of sessions imported from YouTube has **Make video**, which cuts the cited
ranges into one MP4; see [Ask and compilations](/docs/guide/ask-and-compilations#make-a-video).

## Related

- [Example prompts](/docs/agents/example-prompts#wiki)
- [Ask and compilations](/docs/guide/ask-and-compilations)
