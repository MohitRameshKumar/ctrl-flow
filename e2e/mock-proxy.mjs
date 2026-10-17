// Mock AI proxy for e2e tests. Implements the same /task contract as proxy/src/index.ts,
// but returns deterministic canned JSON instead of calling real Claude. No framework — plain
// Node http, since this is a dev-only test tool (no new runtime dependency).
import { createServer } from 'node:http';

const PORT = Number(process.env.MOCK_PROXY_PORT ?? 4411);

// Deterministic domain -> space name mapping so tests can assert exact names.
const DOMAIN_NAMES = {
  'docs.google.com': 'EE 242 homework',
  'github.com': 'Club website',
};
function nameForDomain(domain) {
  return DOMAIN_NAMES[domain] ?? `${domain} space`;
}
function domainOf(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return 'unknown';
  }
}

let failNext = false;

// Honors the same co-usage contract as the real proxy prompt: tabs joined by edges with at least
// MIN_SWITCHES direct switches are one space, regardless of domain or title.
const MIN_SWITCHES = 2;

function components(count, edges) {
  const parent = Array.from({ length: count }, (_, i) => i);
  const find = (i) => {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]];
      i = parent[i];
    }
    return i;
  };
  for (const e of edges ?? []) {
    if (e.switches >= MIN_SWITCHES && e.a < count && e.b < count) parent[find(e.a)] = find(e.b);
  }
  return Array.from({ length: count }, (_, i) => find(i));
}

function linkedName(domains) {
  const unique = [...new Set(domains)].sort();
  return unique.length === 1 ? nameForDomain(unique[0]) : `Linked: ${unique.join(' + ')}`;
}

function handleNameSpaces(input) {
  const urls = input.urls ?? [];
  // Domain-mates are always together; edges then merge domains.
  const domainEdges = [];
  const firstByDomain = new Map();
  urls.forEach((u, i) => {
    const d = domainOf(u.url);
    if (firstByDomain.has(d)) domainEdges.push({ a: firstByDomain.get(d), b: i, switches: MIN_SWITCHES });
    else firstByDomain.set(d, i);
  });
  const roots = components(urls.length, [...domainEdges, ...(input.edges ?? [])]);
  const groups = new Map();
  urls.forEach((u, i) => {
    const list = groups.get(roots[i]) ?? [];
    list.push(i);
    groups.set(roots[i], list);
  });
  const spaces = [...groups.values()].map((idxs) => ({
    name: linkedName(idxs.map((i) => domainOf(urls[i].url))),
    urls: idxs.map((i) => urls[i].url),
  }));
  return { status: 200, body: spaces };
}

function handleAssignTabs(input) {
  const urls = input.urls ?? [];
  const context = input.context ?? [];
  const existing = new Set(input.existingSpaces ?? []);
  const all = [...urls, ...context];
  const roots = components(all.length, input.edges ?? []);

  const assignments = urls.map((u, i) => {
    // Co-used with an already-assigned tab -> that tab's space.
    const ctxIdx = context.findIndex((_, j) => roots[urls.length + j] === roots[i]);
    if (ctxIdx >= 0 && existing.has(context[ctxIdx].space)) {
      return { url: u.url, spaceName: context[ctxIdx].space, newSpaceName: null };
    }
    const mates = urls.filter((_, k) => roots[k] === roots[i]);
    const name = mates.length > 1 ? linkedName(mates.map((m) => domainOf(m.url))) : nameForDomain(domainOf(u.url));
    if (existing.has(name)) return { url: u.url, spaceName: name, newSpaceName: null };
    return { url: u.url, spaceName: null, newSpaceName: name };
  });
  return { status: 200, body: assignments };
}

let lastTaskBody = null;

const server = createServer(async (req, res) => {
  const send = (status, body) => {
    res.writeHead(status, {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type, X-Cadence-Token',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
    });
    res.end(JSON.stringify(body));
  };

  if (req.method === 'OPTIONS') {
    send(204, {});
    return;
  }

  const url = new URL(req.url ?? '/', `http://localhost:${PORT}`);

  if (req.method === 'GET' && url.pathname === '/health') {
    send(200, { ok: true });
    return;
  }

  if (req.method === 'GET' && url.pathname === '/__mock/last') {
    send(200, { last: lastTaskBody });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/__mock/fail') {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
    failNext = body.enabled === true;
    send(200, { failNext });
    return;
  }

  if (req.method !== 'POST' || url.pathname !== '/task') {
    send(404, { error: 'not found' });
    return;
  }

  if (req.headers['x-cadence-token'] !== (process.env.MOCK_PROXY_TOKEN ?? 'test-token')) {
    send(401, { error: 'unauthorized' });
    return;
  }

  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString('utf8');

  if (Buffer.byteLength(raw, 'utf8') > 50 * 1024) {
    send(413, { error: 'request body too large' });
    return;
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    send(400, { error: 'invalid JSON body' });
    return;
  }

  const { task, input } = parsed ?? {};
  lastTaskBody = parsed;

  if (failNext && (task === 'name_spaces' || task === 'assign_tabs')) {
    failNext = false;
    send(502, { error: 'mock failure injected' });
    return;
  }

  switch (task) {
    case 'name_spaces': {
      const result = handleNameSpaces(input ?? {});
      send(result.status, result.body);
      return;
    }
    case 'assign_tabs': {
      const result = handleAssignTabs(input ?? {});
      send(result.status, result.body);
      return;
    }
    case 'standup':
    case 'coverage_doc':
      send(501, { error: `${task} is not implemented yet` });
      return;
    default:
      send(400, { error: 'unknown task' });
  }
});

server.listen(PORT, () => {
  console.log(`[mock-proxy] listening on http://localhost:${PORT}`);
});
