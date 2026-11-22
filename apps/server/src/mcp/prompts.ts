// MCP prompts: ready-made task recipes that tell the agent which tools to call.

export interface PromptDef {
  name: string;
  title: string;
  description: string;
  arguments: { name: string; description: string; required: boolean }[];
  render(args: Record<string, string>): string;
}

const sessionArg = {
  name: 'sessionId',
  description: 'Session id (from sessions_list).',
  required: true,
};

export const PROMPTS: PromptDef[] = [
  {
    name: 'generate_topics',
    title: 'Generate topics',
    description: 'Read a session transcript and (re)write its topics / chapters.',
    arguments: [sessionArg],
    render: ({ sessionId }) => `Generate topics (chapters) for AutoLogger session ${sessionId}.

1. Call sessions_get to see the session, then transcript_text (page through with fromSec/toSec if it is long). Also look at topics_list for what exists and events_list for operator notes that mark segments.
2. Split the conversation into level-1 topics (major segments, usually 3–15 minutes) and optional level-2 sub-topics. Give each a short, specific title and a one- or two-sentence summary.
3. Use the @seconds values from transcript_text as startSec; set durationSec so topics do not overlap.
4. Save everything in one call with topics_replace. The operator can undo it from the Agents tab.
Finally, reply with the list of titles and their start times.`,
  },
  {
    name: 'build_dashboard',
    title: 'Build a dashboard',
    description: 'Design and save a dashboard for a session.',
    arguments: [
      sessionArg,
      { name: 'goal', description: 'What the dashboard should show (optional).', required: false },
    ],
    render: ({
      sessionId,
      goal,
    }) => `Build a dashboard for AutoLogger session ${sessionId}${goal ? ` focused on: ${goal}` : ''}.

1. Read the dashboards_save tool description carefully: it defines the JSON spec (widget types and named queries).
2. Look at the data: sessions_get, events_list, topics_list, and transcript_text if needed. Preview live queries with dashboards_query before using them.
3. Prefer live queries for numbers that change as the session is logged; use static data rows only for things you computed yourself.
4. Save with dashboards_save (omit dashboardId to create a new one; check dashboards_list first to update an existing one instead of duplicating it).
Reply with a short description of the widgets you added.`,
  },
  {
    name: 'update_show_wiki',
    title: 'Update the show wiki',
    description:
      'Write a session recap and update the show wiki (people, recurring bits) from a session.',
    arguments: [sessionArg],
    render: ({ sessionId }) => `Update the show wiki from AutoLogger session ${sessionId}.

1. Call sessions_get (for showId), transcript_text, topics_list and events_list.
2. Call wiki_list for the show and wiki_get on pages you may touch — update existing pages rather than creating duplicates (titles and aliases match).
3. Write a recap page with wiki_upsert (kind "session", with sessionId): summary, key moments with times, and [[links]] to people and recurring bits.
4. Update or create pages for people and recurring bits mentioned in the session, adding what this session revealed and linking back to the recap with [[Title]].
Keep facts grounded in the transcript. Reply with the pages you created or changed.`,
  },
];
