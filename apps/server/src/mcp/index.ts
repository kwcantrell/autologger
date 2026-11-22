// Agent access: OAuth 2.1 authorization server (+ consent API) and the MCP endpoint.
// Imported by main.ts before createApp(), so these routes are mounted ahead of the /api/* 404.

import { registerRoutes } from '../http/app.ts';
import { oauthRoutes } from './oauth.ts';
import { mcpRoutes } from './server.ts';

registerRoutes(oauthRoutes);
registerRoutes(mcpRoutes);
