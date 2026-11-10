import type { ToolSchema } from '../llm/types';
import * as sections from './sections';
import type { PromptEnvironment, PromptRuntime } from './sections';

export interface PromptInput {
  tools: ToolSchema[];
  environment?: PromptEnvironment;
  runtime?: PromptRuntime;
  planActive?: boolean;
  workspaceInstructions?: string;
  sessionRefs?: string[];
  skillCatalog?: Array<{ name: string; description: string }>;
  skills?: string[];
  instructions?: string;
}

export type { PromptEnvironment, PromptRuntime } from './sections';

export function assembleSystemPrompt(input: PromptInput): string {
  const names = new Set((input.tools ?? []).map((tool) => tool.name));
  const hasJobs = names.has('job_list') || names.has('job_output');
  const hasSpill = names.has('read_spill');
  const hasFileRef = names.has('read_file');
  const hasWorkflow = names.has('workflow');
  const assembled = [
    sections.identity(),
    sections.safety(),
    sections.workingAgreement(),
    sections.failureRecovery(),
    input.planActive ? sections.planMode() : '',
    sections.environment(input.environment),
    sections.toolPolicy(input.tools ?? []),
    sections.toolGuidance(input.tools ?? []),
    hasJobs ? sections.backgroundJobs() : '',
    hasSpill ? sections.spilledOutput() : '',
    hasFileRef ? sections.fileReferences() : '',
    hasWorkflow ? sections.workflows() : '',
    (names.has('subagent') || names.has('subagent_fork')) ? sections.delegation() : '',
    sections.runtime(input.runtime),
    input.workspaceInstructions ? sections.workspaceInstructions(input.workspaceInstructions) : '',
    input.sessionRefs && input.sessionRefs.length ? sections.sessionReferences(input.sessionRefs) : '',
    input.skillCatalog?.length ? sections.skillCatalog(input.skillCatalog) : '',
    input.skills?.length ? sections.skills(input.skills) : '',
    input.instructions ? sections.instructions(input.instructions) : '',
  ];

  return assembled.filter(Boolean).join('\n\n');
}
