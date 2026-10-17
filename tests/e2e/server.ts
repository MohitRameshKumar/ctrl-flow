import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * Minimal page server for the E2E suite.
 *
 * The macros under test act on real pages — clicking links, typing into fields, navigating
 * without a reload. Pointing those at example.com or GitHub would make the suite depend on the
 * network and on someone else's markup staying put; a page whose `#searchInput` is renamed
 * upstream would fail the executor tests for a reason that has nothing to do with Cadence.
 *
 * Serves over http on 127.0.0.1, which the content script already matches
 * (`http://*` in `entrypoints/content.ts`), `normalizeUrl` accepts, and the blocklist ignores.
 */

function html(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>${title}</title></head>
<body style="font-family:system-ui;padding:2rem">${body}</body>
</html>`;
}

const PAGES: Record<string, string> = {
  '/page-a': html(
    'Harness page A',
    // The click target must *navigate*, so that "the click happened" is observable from the
    // tab's URL rather than only from a listener the test would have to install.
    `<h1>Page A</h1><a id="more" href="/page-a-target">More information...</a>`,
  ),
  '/page-a-target': html('Harness page A target', '<h1>Clicked through</h1>'),
  '/page-b': html(
    'Harness page B',
    `<h1>Page B</h1><input id="searchInput" aria-label="search box">`,
  ),
  '/page-c': html('Harness page C', '<h1>Page C</h1>'),
  '/dashboard': html('Harness dashboard', '<h1>Dashboard</h1>'),
};

/** Pushes history entries without a document load — the case `onCommitted` cannot see. */
const SPA_PAGE = html(
  'Harness SPA',
  `<h1 id="view">one</h1>
   <button id="go-two">two</button>
   <button id="go-three">three</button>
   <script>
     for (const name of ['two', 'three']) {
       document.getElementById('go-' + name).addEventListener('click', () => {
         history.pushState({}, '', '/spa/' + name);
         document.getElementById('view').textContent = name;
       });
     }
   </script>`,
);

export interface TestServer {
  origin: string;
  close(): Promise<void>;
}

export async function startTestServer(): Promise<TestServer> {
  const server: Server = createServer((req, res) => {
    const path = (req.url ?? '/').split('?')[0] ?? '/';


    // `/acme/web/pull/<id>` and `/<id>/files` mirror the shape the parameterized routine mines,
    // so a run with pull=1234 lands on a real page instead of a 404.
    const body =
      PAGES[path] ??
      (/^\/acme\/web\/pull\/[^/]+(\/files)?$/.test(path)
        ? html(`Pull ${path}`, `<h1>${path}</h1>`)
        : path === '/spa' || path.startsWith('/spa/')
          ? SPA_PAGE
          : undefined);

    if (body === undefined) {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('not found');
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(body);
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;

  return {
    origin: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        // `close()` alone waits for in-flight connections to end, and Chrome holds keep-alive
        // sockets open indefinitely — so without this the fixture teardown never returns and
        // every test dies at its timeout instead of reporting its real result.
        server.closeAllConnections();
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}
