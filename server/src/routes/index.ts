import type { Express } from 'express';
import type { Harness } from '../harness/harness';
import { createApprovalsRouter } from './approvals';
import { createChatRouter } from './chat';
import { createMcpRouter } from './mcp';
import { createMemoryRouter } from './memory';
import { createModelsRouter } from './models';
import { createProjectsRouter } from './projects';
import { createProvidersRouter } from './providers';
import { createFileReferenceRouter } from './files';
import { createSearchRouter } from './search';
import { createSessionsRouter } from './sessions';
import { createSkillsRouter } from './skills';
import { createToolsRouter } from './tools';

/**
 * Every router in one place, mounted through `createApp`'s hook so `requireToken` covers all of
 * them — a second `app.use` outside the hook would be an unauthenticated surface.
 * Skills/goals/workflows (Tasks 27-29) append here.
 */
export function mountRoutes(app: Express, harness: Harness): void {
  app.use('/api/projects', createProjectsRouter(harness));
  app.use('/api/sessions', createSessionsRouter(harness));
  app.use('/api/search', createSearchRouter(harness));
  app.use('/api/files', createFileReferenceRouter(harness));
  app.use('/api/providers', createProvidersRouter(harness));
  app.use('/api/models', createModelsRouter(harness));
  app.use('/api/mcp', createMcpRouter(harness));
  app.use('/api/memory', createMemoryRouter(harness));
  // Tools and skills own session-scoped paths, so they mount at the API root rather than under
  // /tools or /skills. The sessions router falls through on these deeper paths.
  app.use('/api', createToolsRouter(harness));
  app.use('/api', createSkillsRouter(harness));
  app.use('/api/chat', createChatRouter(harness));
  app.use('/api/approvals', createApprovalsRouter(harness));
}
