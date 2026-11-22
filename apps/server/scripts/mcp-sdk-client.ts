// Connects to /mcp with the official MCP SDK client and exercises tools + prompts.
//   node scripts/mcp-sdk-client.ts <baseUrl> <alp_token>
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const [base = 'http://localhost:18081', token] = process.argv.slice(2);
const transport = new StreamableHTTPClientTransport(new URL(`${base.replace(/\/$/, '')}/mcp`), {
  requestInit: { headers: { authorization: `Bearer ${token}` } },
});
const client = new Client({ name: 'autologger-sdk-smoke', version: '1' });
await client.connect(transport);
console.log('instructions:', client.getInstructions()?.slice(0, 80), '…');
const { tools } = await client.listTools();
console.log('tools:', tools.length);
const r = await client.callTool({ name: 'shows_list', arguments: {} });
console.log('shows_list isError:', r.isError ?? false);
const p = await client.getPrompt({
  name: 'generate_topics',
  arguments: { sessionId: 'ses_example' },
});
console.log('prompt messages:', p.messages.length);
await client.close();
