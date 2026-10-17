import { callClaudeForJson } from './anthropic';

export const TASK_NAMES = ['name_spaces', 'assign_tabs', 'standup', 'coverage_doc'] as const;
export type TaskName = (typeof TASK_NAMES)[number];

export interface UrlInput {
  url: string;
  title: string;
}

export interface NameSpacesInput {
  urls: UrlInput[];
}
export interface NameSpacesSpace {
  name: string;
  urls: string[];
}
export type NameSpacesOutput = NameSpacesSpace[];

export interface AssignTabsInput {
  urls: UrlInput[];
  existingSpaces: string[];
}
export interface AssignTabsAssignment {
  url: string;
  spaceName: string | null;
  newSpaceName: string | null;
}
export type AssignTabsOutput = AssignTabsAssignment[];

export interface TaskResult {
  status: number;
  body: unknown;
}

function isUrlList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === 'string');
}

function validateNameSpacesOutput(value: unknown): NameSpacesOutput | null {
  if (!Array.isArray(value) || value.length === 0 || value.length > 7) return null;
  const spaces: NameSpacesSpace[] = [];
  for (const item of value) {
    if (typeof item !== 'object' || item === null) return null;
    const { name, urls } = item as Record<string, unknown>;
    if (typeof name !== 'string' || name.trim().length === 0) return null;
    if (!isUrlList(urls)) return null;
    spaces.push({ name, urls });
  }
  return spaces;
}

function validateAssignTabsOutput(value: unknown): AssignTabsOutput | null {
  if (!Array.isArray(value)) return null;
  const assignments: AssignTabsAssignment[] = [];
  for (const item of value) {
    if (typeof item !== 'object' || item === null) return null;
    const { url, spaceName, newSpaceName } = item as Record<string, unknown>;
    if (typeof url !== 'string') return null;
    if (spaceName !== null && typeof spaceName !== 'string') return null;
    if (newSpaceName !== null && typeof newSpaceName !== 'string') return null;
    assignments.push({
      url,
      spaceName: spaceName ?? null,
      newSpaceName: newSpaceName ?? null,
    });
  }
  return assignments;
}

async function handleNameSpaces(apiKey: string, input: unknown): Promise<TaskResult> {
  const typed = input as NameSpacesInput;
  if (!typed || !isUrlList(typed.urls?.map((u) => u.url))) {
    return { status: 400, body: { error: 'invalid input for name_spaces' } };
  }

  const urlList = typed.urls.map((u) => `- ${u.title || '(untitled)'} — ${u.url}`).join('\n');
  const system = `You group a user's open browser tabs into project workspaces ("spaces").
Group the given URLs into 2 to 7 spaces with short, human-readable names (e.g. "EE 242 homework", "Club website").
Any URL that doesn't clearly fit a group should simply be left out of every space's "urls" array (it stays unassigned).
Output JSON: an array of objects, each {"name": string, "urls": string[]}. The "urls" values must be exactly the URLs given to you, unmodified.`;

  const result = await callClaudeForJson(apiKey, system, urlList, validateNameSpacesOutput);
  if (!result.ok) {
    console.error('[cadence-proxy] name_spaces failed', result.reason, result.detail);
    return { status: 502, body: { error: 'model did not return valid JSON' } };
  }
  return { status: 200, body: result.value };
}

async function handleAssignTabs(apiKey: string, input: unknown): Promise<TaskResult> {
  const typed = input as AssignTabsInput;
  if (!typed || !Array.isArray(typed.urls) || !Array.isArray(typed.existingSpaces)) {
    return { status: 400, body: { error: 'invalid input for assign_tabs' } };
  }

  const urlList = typed.urls.map((u) => `- ${u.title || '(untitled)'} — ${u.url}`).join('\n');
  const spaceList = typed.existingSpaces.map((s) => `- ${s}`).join('\n') || '(none yet)';
  const system = `You assign new browser tabs to a user's existing project workspaces ("spaces").
Existing spaces:
${spaceList}

For each URL below, decide one of three things: it belongs in an existing space (set "spaceName" to that exact existing name), it should start a brand-new space (set "newSpaceName" to a short human-readable name), or it doesn't fit anywhere yet (leave both "spaceName" and "newSpaceName" as null).
Output JSON: an array with exactly one object per URL given, each {"url": string, "spaceName": string | null, "newSpaceName": string | null}. The "url" values must be exactly the URLs given to you, unmodified.`;

  const result = await callClaudeForJson(apiKey, system, urlList, validateAssignTabsOutput);
  if (!result.ok) {
    console.error('[cadence-proxy] assign_tabs failed', result.reason, result.detail);
    return { status: 502, body: { error: 'model did not return valid JSON' } };
  }
  return { status: 200, body: result.value };
}

export async function runTask(task: TaskName, apiKey: string, input: unknown): Promise<TaskResult> {
  switch (task) {
    case 'name_spaces':
      return handleNameSpaces(apiKey, input);
    case 'assign_tabs':
      return handleAssignTabs(apiKey, input);
    case 'standup':
    case 'coverage_doc':
      return { status: 501, body: { error: `${task} is not implemented yet` } };
  }
}
