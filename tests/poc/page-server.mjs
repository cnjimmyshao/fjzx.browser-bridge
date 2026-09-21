import { createServer } from 'node:http';

/**
 * The local test page the POC runs against.
 *
 * Everything here exists to make Bridge's behaviour observable without touching a
 * real site: a readable DOM, a button whose effect is visible, a page-world
 * variable (which is what proves the script runs isolated from the page), and a
 * variant that merely *mentions* a challenge so the POC can show Bridge treats it
 * as ordinary page content.
 *
 * Not shipped, and not part of the extension. Bridge's source contains no site
 * business semantics; this file is where a fake website is allowed to.
 */

/** @param {string} body @param {string} inlineScript */
function renderPage(body, inlineScript = '') {
  return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>Browser Bridge test page</title>
  </head>
  <body>
    ${body}
    <script>
      window.__pageSecret = 'set-by-the-page-world';
      window.__pageClicks = 0;
      const button = document.getElementById('work-button');
      if (button) {
        button.addEventListener('click', () => {
          window.__pageClicks += 1;
          document.getElementById('work-state').textContent = 'clicked:' + window.__pageClicks;
        });
      }
      ${inlineScript}
    </script>
  </body>
</html>`;
}

const INTERACTIVE = renderPage(`
  <h1 id="work-heading">Bridge work tab</h1>
  <p id="work-state">idle</p>
  <input id="work-input" value="initial" />
  <button id="work-button">do work</button>
`);

/**
 * A page that talks about a challenge without being one.
 *
 * The point of the scenario is that Bridge has no opinion here: it returns what
 * the script saw and the Service decides what it means. If Bridge ever grew a
 * BLOCKED/CAPTCHA state, this page is what would expose it.
 */
const CHALLENGE_LOOKING = renderPage(
  `
  <h1 id="work-heading">Bridge work tab</h1>
  <p id="work-state">idle</p>
  <input id="work-input" value="initial" />
  <button id="work-button">do work</button>
  <div id="challenge">Please complete the captcha to continue</div>
`,
  "window.__challengeShown = true;",
);

/** @param {{port?: number}} [options] */
export async function startTestPageServer(options = {}) {
  const { port = 0 } = options;

  const server = createServer((request, response) => {
    const path = (request.url ?? '/').split('?')[0];
    const body = path === '/challenge' ? CHALLENGE_LOOKING : INTERACTIVE;
    response.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
    });
    response.end(body);
  });

  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
  const boundPort = server.address().port;

  return {
    port: boundPort,
    urlFor: (path = '/') => `http://127.0.0.1:${boundPort}${path}`,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections?.();
        server.close(resolve);
      }),
  };
}
