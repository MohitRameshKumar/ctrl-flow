import { TASK_NAMES, runTask, type TaskEnv, type TaskName } from './tasks';

export interface Env extends TaskEnv {
  CADENCE_TOKEN: string;
  ALLOWED_ORIGIN: string;
}

const MAX_BODY_BYTES = 50 * 1024;

function corsHeaders(origin: string): HeadersInit {
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-Cadence-Token',
    'Access-Control-Max-Age': '86400',
  };
}

function json(status: number, body: unknown, origin: string): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) },
  });
}

function isTaskName(value: string): value is TaskName {
  return (TASK_NAMES as readonly string[]).includes(value);
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const origin = env.ALLOWED_ORIGIN;

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders(origin) });
    }

    const url = new URL(request.url);
    if (request.method !== 'POST' || url.pathname !== '/task') {
      return json(404, { error: 'not found' }, origin);
    }

    if (request.headers.get('X-Cadence-Token') !== env.CADENCE_TOKEN) {
      return json(401, { error: 'unauthorized' }, origin);
    }

    const contentLength = Number(request.headers.get('Content-Length') ?? '0');
    if (contentLength > MAX_BODY_BYTES) {
      return json(413, { error: 'request body too large' }, origin);
    }

    const rawBody = await request.text();
    if (new TextEncoder().encode(rawBody).length > MAX_BODY_BYTES) {
      return json(413, { error: 'request body too large' }, origin);
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(rawBody);
    } catch {
      return json(400, { error: 'invalid JSON body' }, origin);
    }

    if (typeof parsed !== 'object' || parsed === null) {
      return json(400, { error: 'invalid request body' }, origin);
    }
    const { task, input } = parsed as Record<string, unknown>;
    if (typeof task !== 'string' || !isTaskName(task)) {
      return json(400, { error: 'unknown task' }, origin);
    }

    const result = await runTask(task, env, ctx, input);
    return json(result.status, result.body, origin);
  },
} satisfies ExportedHandler<Env>;
