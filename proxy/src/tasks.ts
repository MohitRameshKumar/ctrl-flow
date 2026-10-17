import { completeJson, completeText, selectProvider, type LlmEnv, type LlmProvider } from './llm';

export const TASK_NAMES = ['name_spaces', 'assign_tabs', 'standup', 'coverage_doc'] as const;
export type TaskName = (typeof TASK_NAMES)[number];

export interface UrlInput {
  url: string;
  title: string;
}

export interface EdgeInput {
  a: number;
  b: number;
  switches: number;
  near: number;
}
export interface TypedInput {
  i: number;
  bursts: number;
}
export interface ContextUrlInput extends UrlInput {
  space: string;
}

export interface NameSpacesInput {
  urls: UrlInput[];
  edges?: EdgeInput[];
  typed?: TypedInput[];
}
export interface NameSpacesSpace {
  name: string;
  urls: string[];
}
export type NameSpacesOutput = NameSpacesSpace[];

export interface AssignTabsInput {
  urls: UrlInput[];
  existingSpaces: string[];
  /** Already-assigned tabs co-used with the new ones. Edge/typed indices continue after `urls`. */
  context?: ContextUrlInput[];
  edges?: EdgeInput[];
  typed?: TypedInput[];
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


const MAX_EDGES = 60;
const COUSAGE_GUIDE = `Each tab is numbered [n]. You are also given co-usage signals computed on the user's device: "switches" is how often the user switched directly between two tabs, "near" is how often they were open/active within ~90 seconds of each other, and "typing bursts" counts how often the user typed in a tab (a sign it is the tab being worked in, e.g. a notes doc).
CO-USAGE IS THE PRIMARY SIGNAL. Tabs the user keeps switching between belong in the same space, even when their titles or domains differ (for example two news articles and an "Untitled document" the user takes notes in are one research project). Use titles and domains only as a secondary signal, to name the space and to place tabs that have no co-usage data. Do not split tabs that are strongly co-used; do not merge tabs that have no co-usage and unrelated titles.`;

function validEdges(value: unknown, tabCount: number): EdgeInput[] {
  if (!Array.isArray(value)) return [];
  const edges: EdgeInput[] = [];
  for (const e of value) {
    if (typeof e !== 'object' || e === null) continue;
    const { a, b, switches, near } = e as Record<string, unknown>;
    if (![a, b, switches, near].every((n) => typeof n === 'number' && Number.isFinite(n))) continue;
    const [ia, ib] = [a as number, b as number];
    if (!Number.isInteger(ia) || !Number.isInteger(ib) || ia < 0 || ib < 0 || ia >= tabCount || ib >= tabCount || ia === ib) continue;
    edges.push({ a: ia, b: ib, switches: switches as number, near: near as number });
    if (edges.length >= MAX_EDGES) break;
  }
  return edges;
}

function validTyped(value: unknown, tabCount: number): TypedInput[] {
  if (!Array.isArray(value)) return [];
  const typed: TypedInput[] = [];
  for (const t of value) {
    if (typeof t !== 'object' || t === null) continue;
    const { i, bursts } = t as Record<string, unknown>;
    if (typeof i !== 'number' || typeof bursts !== 'number' || !Number.isInteger(i) || i < 0 || i >= tabCount) continue;
    typed.push({ i, bursts });
  }
  return typed;
}

function formatSignals(edges: EdgeInput[], typed: TypedInput[]): string {
  const lines: string[] = [];
  if (edges.length > 0) {
    lines.push('Co-usage between tabs:');
    for (const e of edges) lines.push(`- [${e.a}] <-> [${e.b}]: ${e.switches} switches, ${e.near} near`);
  } else {
    lines.push('Co-usage between tabs: none recorded.');
  }
  if (typed.length > 0) {
    lines.push('Typing bursts:');
    for (const t of typed) lines.push(`- [${t.i}]: ${t.bursts}`);
  }
  return lines.join('\n');
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

async function handleNameSpaces(provider: LlmProvider, input: unknown): Promise<TaskResult> {
  const typed = input as NameSpacesInput;
  if (!typed || !isUrlList(typed.urls?.map((u) => u.url))) {
    return { status: 400, body: { error: 'invalid input for name_spaces' } };
  }

  const tabLines = typed.urls.map((u, i) => `[${i}] ${u.title || '(untitled)'} — ${u.url}`).join('\n');
  const signals = formatSignals(validEdges(typed.edges, typed.urls.length), validTyped(typed.typed, typed.urls.length));
  const urlList = `Tabs:\n${tabLines}\n\n${signals}`;
  const system = `You group a user's open browser tabs into project workspaces ("spaces").
${COUSAGE_GUIDE}
Group the given URLs into 2 to 7 spaces with short, human-readable names (e.g. "EE 242 homework", "Club website"). If everything truly belongs to one project, a single space is fine.
Any URL that doesn't clearly fit a group should simply be left out of every space's "urls" array (it stays unassigned).
Output JSON: an array of objects, each {"name": string, "urls": string[]}. The "urls" values must be exactly the URLs given to you, unmodified.`;

  const result = await completeJson(provider, system, urlList, 'fast', validateNameSpacesOutput);
  if (!result.ok) {
    console.error('[cadence-proxy] name_spaces failed', result.reason, result.detail);
    return { status: 502, body: { error: 'model did not return valid JSON' } };
  }
  return { status: 200, body: result.value };
}

async function handleAssignTabs(provider: LlmProvider, input: unknown): Promise<TaskResult> {
  const typed = input as AssignTabsInput;
  if (!typed || !Array.isArray(typed.urls) || !Array.isArray(typed.existingSpaces)) {
    return { status: 400, body: { error: 'invalid input for assign_tabs' } };
  }

  const context = Array.isArray(typed.context) ? typed.context : [];
  const tabCount = typed.urls.length + context.length;
  const tabLines = typed.urls.map((u, i) => `[${i}] ${u.title || '(untitled)'} — ${u.url}`).join('\n');
  const contextLines = context
    .map((c, j) => `[${typed.urls.length + j}] ${c.title || '(untitled)'} — ${c.url} (already in space "${c.space}")`)
    .join('\n');
  const signals = formatSignals(validEdges(typed.edges, tabCount), validTyped(typed.typed, tabCount));
  const urlList = `New tabs to assign:\n${tabLines}\n\n${
    contextLines ? `Already-assigned tabs, for context only (do not output these):\n${contextLines}\n\n` : ''
  }${signals}`;
  const spaceList = typed.existingSpaces.map((s) => `- ${s}`).join('\n') || '(none yet)';
  const system = `You assign new browser tabs to a user's existing project workspaces ("spaces").
${COUSAGE_GUIDE}
A new tab that is strongly co-used with an already-assigned tab belongs in that tab's space.
Existing spaces:
${spaceList}

For each NEW tab, decide one of three things: it belongs in an existing space (set "spaceName" to that exact existing name), it should start a brand-new space (set "newSpaceName" to a short human-readable name), or it doesn't fit anywhere yet (leave both "spaceName" and "newSpaceName" as null). New tabs that are co-used with each other but with nothing existing should share one newSpaceName.
Output JSON: an array with exactly one object per NEW tab given, each {"url": string, "spaceName": string | null, "newSpaceName": string | null}. The "url" values must be exactly the URLs given to you, unmodified.`;

  const result = await completeJson(provider, system, urlList, 'fast', validateAssignTabsOutput);
  if (!result.ok) {
    console.error('[cadence-proxy] assign_tabs failed', result.reason, result.detail);
    return { status: 502, body: { error: 'model did not return valid JSON' } };
  }
  return { status: 200, body: result.value };
}

// ---- standup ------------------------------------------------------------------------------------

export interface StandupOutput {
  yesterday: string[];
  today: string[];
  blockers: string[];
}

const MAX_ITEMS = 12;
const MAX_ITEM_CHARS = 300;
const MAX_STRING = 200;
const MAX_LIST = 40;

function cleanStr(v: unknown, max = MAX_STRING): string {
  return typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, max) : '';
}

/** Keeps only expected scalar fields of each list item and caps list lengths: a second line of defence behind the client. */
function cleanList(v: unknown, fields: Record<string, 'string' | 'number'>, max = MAX_LIST): Record<string, unknown>[] {
  if (!Array.isArray(v)) return [];
  return v.slice(0, max).flatMap((item) => {
    if (typeof item !== 'object' || item === null) return [];
    const out: Record<string, unknown> = {};
    for (const [key, type] of Object.entries(fields)) {
      const val = (item as Record<string, unknown>)[key];
      out[key] = type === 'number' ? (typeof val === 'number' && Number.isFinite(val) ? val : 0) : cleanStr(val);
    }
    return [out];
  });
}

function validateStandupOutput(value: unknown): StandupOutput | null {
  if (typeof value !== 'object' || value === null) return null;
  const { yesterday, today, blockers } = value as Record<string, unknown>;
  const list = (v: unknown, required: boolean): string[] | null => {
    if (v === undefined && !required) return [];
    if (!Array.isArray(v) || v.length > MAX_ITEMS || !v.every((x) => typeof x === 'string')) return null;
    return v.map((x: string) => x.trim().slice(0, MAX_ITEM_CHARS)).filter(Boolean);
  };
  const y = list(yesterday, true);
  const t = list(today, true);
  const b = list(blockers, false);
  return y && t && b ? { yesterday: y, today: t, blockers: b } : null;
}

async function handleStandup(provider: LlmProvider, input: unknown): Promise<TaskResult> {
  const raw = input as Record<string, unknown> | null;
  if (!raw || typeof raw !== 'object' || typeof raw.range !== 'object' || raw.range === null) {
    return { status: 400, body: { error: 'invalid input for standup' } };
  }
  const range = raw.range as Record<string, unknown>;
  const today = (raw.today ?? {}) as Record<string, unknown>;
  const data = {
    range: { label: cleanStr(range.label), from: cleanStr(range.from, 20), to: cleanStr(range.to, 20) },
    spaces: cleanList(raw.spaces, { name: 'string', minutes: 'number' }, 10),
    pages: cleanList(raw.pages, { title: 'string', domain: 'string', minutes: 'number' }, 15),
    typingInDocs: cleanList(raw.typing, { title: 'string', domain: 'string', bursts: 'number' }, 10),
    github: cleanList(raw.github, { kind: 'string', title: 'string', url: 'string', minutes: 'number' }, 10),
    meetingsAttended: cleanList(raw.meetings, { title: 'string', start: 'string', minutes: 'number' }, 15),
    today: {
      meetings: cleanList(today.meetings, { title: 'string', start: 'string', minutes: 'number' }, 15),
      lastSpace: cleanStr(today.lastSpace) || null,
    },
  };

  const system = `You write a short daily standup for the user from a summary of their own browser activity.
Output JSON: {"yesterday": string[], "today": string[], "blockers": string[]}.
- "yesterday": 2 to 6 bullets about the period "${data.range.label}", first person, past tense (e.g. "Worked on the EE 242 homework"). Group related items. Base every bullet ONLY on the data: spaces (minutes spent), pages, typingInDocs (documents the user wrote in; you never see what they wrote), github pages, and meetingsAttended. Do not invent tasks, outcomes, people, or numbers that aren't in the data. Mention durations only when they're notable.
- "today": bullets from today.meetings (include the time) and, if today.lastSpace is set, continuing work in that space. Empty array if there is nothing.
- "blockers": ONLY something the data explicitly shows (for example a GitHub issue titled as broken or blocked). Otherwise an empty array. Never invent blockers.
Plain text bullets, no markdown, each under 200 characters.`;

  const result = await completeJson(provider, system, JSON.stringify(data), 'writing', validateStandupOutput, 1500);
  if (!result.ok) {
    console.error('[cadence-proxy] standup failed', result.reason, result.detail);
    return { status: 502, body: { error: 'model did not return a valid standup' } };
  }
  return { status: 200, body: result.value };
}

// ---- coverage doc -------------------------------------------------------------------------------

const COVERAGE_HEADINGS = ['## Duties', '## Recurring meetings', '## Active projects', '## Key links'];

function cleanLinks(v: unknown, max: number): Record<string, unknown>[] {
  return cleanList(v, { title: 'string', url: 'string' }, max);
}

async function handleCoverageDoc(provider: LlmProvider, input: unknown): Promise<TaskResult> {
  const raw = input as Record<string, unknown> | null;
  if (!raw || typeof raw !== 'object' || typeof raw.range !== 'object' || raw.range === null) {
    return { status: 400, body: { error: 'invalid input for coverage_doc' } };
  }
  const range = raw.range as Record<string, unknown>;
  const data = {
    outOfOffice: { from: cleanStr(range.from, 20), to: cleanStr(range.to, 20), days: typeof range.days === 'number' ? range.days : 0 },
    recurringMeetings: (Array.isArray(raw.recurringMeetings) ? raw.recurringMeetings : []).slice(0, 15).flatMap((m) => {
      if (typeof m !== 'object' || m === null) return [];
      const r = m as Record<string, unknown>;
      return [{ title: cleanStr(r.title), cadence: cleanStr(r.cadence, 40), occurrencesInRange: typeof r.occurrencesInRange === 'number' ? r.occurrencesInRange : 0, links: cleanLinks(r.links, 6) }];
    }),
    rituals: (Array.isArray(raw.rituals) ? raw.rituals : []).slice(0, 15).flatMap((m) => {
      if (typeof m !== 'object' || m === null) return [];
      const r = m as Record<string, unknown>;
      return [{ title: cleanStr(r.title), status: cleanStr(r.status, 20), docs: cleanLinks(r.docs, 6) }];
    }),
    projects: (Array.isArray(raw.spaces) ? raw.spaces : []).slice(0, 8).flatMap((m) => {
      if (typeof m !== 'object' || m === null) return [];
      const r = m as Record<string, unknown>;
      return [{ name: cleanStr(r.name), topTabs: cleanLinks(r.topTabs, 5) }];
    }),
    weeklyDuties: cleanList(raw.weeklyDuties, { domain: 'string', daysVisited: 'number', exampleTitle: 'string' }, 12),
  };

  const system = `You write a coverage / handoff document for a teammate who covers for the user while they are out (${data.outOfOffice.from} to ${data.outOfOffice.to}).
Use ONLY the data provided. Never invent people, deadlines, contacts, credentials, or tasks. Output Markdown only (no code fences), exactly this structure:
# Coverage doc: <from> to <to>
## Duties
## Recurring meetings
## Active projects
## Key links
- Duties: bullets for each weeklyDuties entry (a site the user visits on several days each week, so it is probably a recurring duty). Say what the site/example page suggests, hedged ("likely"), and link it only if a URL is given.
- Recurring meetings: each meeting with its cadence and how many fall in the out-of-office range, plus its prep doc links as Markdown links.
- Active projects: each project with its main tabs as Markdown links.
- Key links: a deduplicated list of the most important Markdown links from the data.
If a section has no data, write a single bullet "(none)".`;

  const result = await completeText(
    provider,
    system,
    JSON.stringify(data),
    'writing',
    (text) => (COVERAGE_HEADINGS.every((h) => text.includes(h)) ? text : null),
    3000,
  );
  if (!result.ok) {
    console.error('[cadence-proxy] coverage_doc failed', result.reason, result.detail);
    return { status: 502, body: { error: 'model did not return a valid coverage doc' } };
  }
  return { status: 200, body: { markdown: result.value } };
}

export async function runTask(task: TaskName, env: LlmEnv, input: unknown): Promise<TaskResult> {
  const provider = selectProvider(env);
  switch (task) {
    case 'name_spaces':
      return handleNameSpaces(provider, input);
    case 'assign_tabs':
      return handleAssignTabs(provider, input);
    case 'standup':
      return handleStandup(provider, input);
    case 'coverage_doc':
      return handleCoverageDoc(provider, input);
  }
}
