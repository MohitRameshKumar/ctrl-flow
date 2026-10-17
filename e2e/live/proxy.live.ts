import { expect, test } from '@playwright/test';

const PROXY_URL = process.env.WXT_PROXY_URL;
const PROXY_TOKEN = process.env.WXT_PROXY_TOKEN;

test.skip(
  !PROXY_URL || !PROXY_TOKEN,
  'Live proxy tests skipped: set WXT_PROXY_URL and WXT_PROXY_TOKEN to run them (the proxy may not be deployed yet).',
);

async function post(task: string, input: unknown, token: string | undefined = PROXY_TOKEN) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token) headers['X-Cadence-Token'] = token;
  return fetch(`${PROXY_URL!.replace(/\/$/, '')}/task`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ task, input }),
  });
}

const URLS = [
  { url: 'https://docs.google.com/document/d/ee242-hw3', title: 'EE 242 HW 3' },
  { url: 'https://canvas.uw.edu/courses/ee242', title: 'EE 242 - Canvas' },
  { url: 'https://github.com/uw-club/website', title: 'club website repo' },
  { url: 'https://github.com/uw-club/website/issues', title: 'Issues - club website' },
];

test('rejects a request without the token', async () => {
  const res = await post('name_spaces', { urls: URLS }, '');
  expect([401, 403]).toContain(res.status);
});

test('name_spaces returns well-formed spaces using only the URLs it was given', async () => {
  const res = await post('name_spaces', { urls: URLS });
  expect(res.status).toBe(200);
  const body = (await res.json()) as { name: string; urls: string[] }[];
  expect(Array.isArray(body)).toBe(true);
  expect(body.length).toBeGreaterThan(0);
  const given = new Set(URLS.map((u) => u.url));
  for (const space of body) {
    expect(typeof space.name).toBe('string');
    expect(space.name.length).toBeGreaterThan(0);
    for (const u of space.urls) expect(given.has(u)).toBe(true);
  }
});

test('name_spaces groups tabs by co-usage even when titles and domains look unrelated', async () => {
  const urls = [
    { url: 'https://www.nytimes.com/2026/10/10/technology/ai-boom.html', title: 'The AI Boom Is Here' },
    { url: 'https://www.theverge.com/2026/10/9/llm-explained', title: 'How large language models actually work' },
    { url: 'https://docs.google.com/document/d/abc/edit', title: 'Untitled document' },
    { url: 'https://www.allrecipes.com/recipe/carbonara', title: 'Spaghetti Carbonara Recipe' },
    { url: 'https://www.zillow.com/homes/seattle', title: 'Seattle Homes for Sale' },
  ];
  const res = await post('name_spaces', {
    urls,
    // 0, 1, 2 were switched between constantly and notes were typed in the doc; 3 and 4 were barely touched.
    edges: [
      { a: 0, b: 2, switches: 6, near: 9 },
      { a: 1, b: 2, switches: 6, near: 9 },
      { a: 0, b: 1, switches: 2, near: 6 },
      { a: 3, b: 4, switches: 1, near: 1 },
    ],
    typed: [{ i: 2, bursts: 12 }],
  });
  expect(res.status).toBe(200);
  const body = (await res.json()) as { name: string; urls: string[] }[];
  const spaceOf = (u: string) => body.findIndex((sp) => sp.urls.includes(u));
  const idx = [0, 1, 2].map((i) => spaceOf(urls[i]!.url));
  expect(idx[0]).toBeGreaterThanOrEqual(0);
  expect(new Set(idx).size).toBe(1);
  expect(spaceOf(urls[3]!.url)).not.toBe(idx[0]);
});

test('assign_tabs returns exactly one assignment per URL', async () => {
  const res = await post('assign_tabs', { urls: URLS.slice(0, 2), existingSpaces: ['Club website'] });
  expect(res.status).toBe(200);
  const body = (await res.json()) as { url: string; spaceName: string | null; newSpaceName: string | null }[];
  expect(body).toHaveLength(2);
  expect(body.map((a) => a.url).sort()).toEqual(URLS.slice(0, 2).map((u) => u.url).sort());
});

test('standup and coverage_doc return 501 (not built)', async () => {
  for (const task of ['standup', 'coverage_doc']) {
    const res = await post(task, {});
    expect(res.status).toBe(501);
  }
});
