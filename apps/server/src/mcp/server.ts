// The MCP server: stateless Streamable HTTP at POST /mcp. Tools are generated from the ops
// registry (every op exposed on the 'mcp' surface), so adding an op adds a tool.

import { type OpName, opInputs } from '@autologger/contract';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import {
  CallToolRequestSchema,
  type CallToolResult,
  GetPromptRequestSchema,
  ListPromptsRequestSchema,
  ListToolsRequestSchema,
  type Tool,
} from '@modelcontextprotocol/sdk/types.js';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { z } from 'zod';
import { toRpcError } from '../core/errors.ts';
import { type Actor, executeOp, listOps } from '../core/op.ts';
import { bearerFrom } from '../http/app.ts';
import { resourceMetadataUrl } from './oauth.ts';
import { PROMPTS } from './prompts.ts';
import { actorFromBearer } from './tokens.ts';

export const SERVER_INSTRUCTIONS = `AutoLogger is a logging tool for live productions (podcasts, shoots, streams). Operators log timecoded events during a session; audio is transcribed. You act as the user who connected you, with their access.

Data model: teams → shows → sessions. A session has events (timecoded log entries tied to category buttons), a transcript (speaker turns), topics (chapters), dashboards and recap wiki pages; each show has a wiki.

Finding ids: shows_list → sessions_list (filter by showId) → sessions_get. Read the transcript with transcript_text (format "compact" for long sessions; page with fromSec/toSec, using totalSegments/durationSec from the first call) and the log with events_list. search does full-text search across everything you can read. To fix transcript errors, transcript_find returns matching segment ids and transcript_updateSegments corrects many segments in one call; transcript_mergeSegments and transcript_splitSegment fix segments that are split mid-phrase, out of order or span a speaker change.

Setup: if the user asks for a new team, create it with teams_create (you become its owner). If a team has no show yet, a team owner/admin can create one with shows_create (teamId from teams_list) and set its event buttons with categories_save. Shows are deleted only in the web app.

Time conventions: atSec / startSec / durationSec are seconds from the session start and line up with transcript_text, where each line looks like \`[HH:MM:SS @123.4s] Speaker: text\` (format "compact": paragraphs \`@123.4 Speaker: text\` with inline \`[@183.4]\` stamps) — use the @seconds value. timecode strings (HH:MM:SS:FF) are on the session clock (frame rate and start offset in sessions_get). Prefer atSec when working from the transcript.

Writes apply immediately, are attributed to you (this client) in the session's change log, and the operator can undo any of them from the Agents tab — so act, but stay within what was asked. topics_replace swaps the whole topic list (the usual way to (re)generate chapters); events_createMany logs many events at once.

Dashboards: dashboards_save takes a declarative JSON spec (its description lists widget types and named queries; preview data with dashboards_query). Nothing you write is executed or rendered as HTML.

Wiki: wiki_upsert writes Markdown pages per show (people, recurring bits, session recaps); link pages with [[Title]]. Read before writing (wiki_list / wiki_get) and update existing pages rather than duplicating them.`;

/** `events.create` → `events_create`. */
export const toolName = (op: string) => op.replace(/\./g, '_');

// categories.save deletes every button missing from the list.
const DESTRUCTIVE =
  /\.(delete|replace|revert|restore|archive|removeMember|leave|revoke)|^categories\.save$/;

let toolCache: { tools: Tool[]; byTool: Map<string, OpName> } | null = null;

function inputSchema(op: OpName): Tool['inputSchema'] {
  const schema = opInputs[op] as z.ZodType;
  const json = z.toJSONSchema(schema, { io: 'input', unrepresentable: 'any' }) as Record<
    string,
    unknown
  >;
  delete json.$schema;
  if (json.type !== 'object') return { type: 'object', properties: {} };
  return json as Tool['inputSchema'];
}

export function mcpTools(): { tools: Tool[]; byTool: Map<string, OpName> } {
  if (toolCache) return toolCache;
  const byTool = new Map<string, OpName>();
  const tools: Tool[] = listOps('mcp').map((op) => {
    const name = toolName(op.name);
    byTool.set(name, op.name);
    return {
      name,
      title: op.name,
      description: op.description,
      inputSchema: inputSchema(op.name),
      annotations:
        op.kind === 'read'
          ? { readOnlyHint: true, openWorldHint: false }
          : {
              readOnlyHint: false,
              destructiveHint: DESTRUCTIVE.test(op.name),
              openWorldHint: false,
            },
    };
  });
  toolCache = { tools, byTool };
  return toolCache;
}

function resultContent(op: OpName, data: unknown): CallToolResult {
  // The transcript is meant to be read as text; everything else is JSON.
  if (op === 'transcript.text' && data && typeof (data as { text?: unknown }).text === 'string') {
    const { text, ...counts } = data as { text: string };
    return {
      content: [
        { type: 'text', text: text || '(no transcript yet)' },
        { type: 'text', text: JSON.stringify(counts) },
      ],
    };
  }
  return { content: [{ type: 'text', text: JSON.stringify(data ?? null) }] };
}

export function createMcpServer(actor: Actor): Server {
  const server = new Server(
    { name: 'autologger', title: 'AutoLogger', version: '3.0.0' },
    { capabilities: { tools: {}, prompts: {} }, instructions: SERVER_INSTRUCTIONS },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: mcpTools().tools }));

  server.setRequestHandler(CallToolRequestSchema, async (req, extra): Promise<CallToolResult> => {
    const op = mcpTools().byTool.get(req.params.name);
    if (!op)
      return {
        isError: true,
        content: [{ type: 'text', text: `Unknown tool ${req.params.name}.` }],
      };
    try {
      const data = await executeOp(op, req.params.arguments ?? {}, actor, 'mcp', extra.signal);
      return resultContent(op, data);
    } catch (e) {
      const err = toRpcError(e);
      const issues = err.issues?.length
        ? `\n${err.issues.map((i) => `- ${i.path || '(input)'}: ${i.message}`).join('\n')}`
        : '';
      return {
        isError: true,
        content: [{ type: 'text', text: `${err.code}: ${err.message}${issues}` }],
      };
    }
  });

  server.setRequestHandler(ListPromptsRequestSchema, async () => ({
    prompts: PROMPTS.map(({ name, title, description, arguments: args }) => ({
      name,
      title,
      description,
      arguments: args,
    })),
  }));

  server.setRequestHandler(GetPromptRequestSchema, async (req) => {
    const p = PROMPTS.find((x) => x.name === req.params.name);
    if (!p) throw new Error(`Unknown prompt ${req.params.name}`);
    const args = req.params.arguments ?? {};
    for (const a of p.arguments)
      if (a.required && !args[a.name]) throw new Error(`Missing argument ${a.name}`);
    return {
      description: p.description,
      messages: [{ role: 'user', content: { type: 'text', text: p.render(args) } }],
    };
  });

  return server;
}

export const mcpRoutes = new Hono();

mcpRoutes.use(
  '/mcp',
  cors({
    origin: '*',
    allowMethods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
    allowHeaders: [
      'Content-Type',
      'Authorization',
      'Mcp-Session-Id',
      'MCP-Protocol-Version',
      'Last-Event-ID',
    ],
    exposeHeaders: ['WWW-Authenticate', 'Mcp-Session-Id', 'MCP-Protocol-Version'],
    maxAge: 86400,
  }),
);

mcpRoutes.post('/mcp', async (c) => {
  const token = bearerFrom(c.req.header('authorization'));
  const actor = token ? await actorFromBearer(token) : null;
  if (!actor) {
    const params = [`resource_metadata="${resourceMetadataUrl()}"`];
    if (token)
      params.unshift(
        'error="invalid_token"',
        'error_description="The access token is invalid, expired or revoked."',
      );
    c.header('WWW-Authenticate', `Bearer ${params.join(', ')}`);
    return c.json(
      { jsonrpc: '2.0', error: { code: -32001, message: 'Authentication required.' }, id: null },
      401,
    );
  }
  const server = createMcpServer(actor);
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  await server.connect(transport);
  try {
    return await transport.handleRequest(c.req.raw);
  } finally {
    void server.close();
  }
});

const notAllowed = () =>
  new Response(
    JSON.stringify({
      jsonrpc: '2.0',
      error: { code: -32000, message: 'Method not allowed. This server is stateless; use POST.' },
      id: null,
    }),
    {
      status: 405,
      headers: { 'Content-Type': 'application/json', Allow: 'POST' },
    },
  );
mcpRoutes.get('/mcp', notAllowed);
mcpRoutes.delete('/mcp', notAllowed);
