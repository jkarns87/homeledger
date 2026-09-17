/**
 * View-side MCP Apps bridge, hand-written so each widget stays one file with
 * no external assets. Wire protocol taken from @modelcontextprotocol/ext-apps
 * 2.0.0: ui/initialize (request, result carries hostContext), then
 * ui/notifications/initialized, then host-to-view notifications
 * ui/notifications/tool-result, ui/notifications/tool-input,
 * ui/notifications/tool-cancelled and ui/notifications/host-context-changed.
 * Tool calls go to the host as plain MCP tools/call requests over the same
 * postMessage channel. Incoming messages are rejected unless event.source is
 * window.parent, matching the package's own PostMessageTransport.
 *
 * Written without template literals on purpose: the widget files embed this
 * with String.raw, so a dollar-brace sequence here would be interpolated.
 */
export const BRIDGE_SCRIPT = String.raw`
(function () {
  var pending = {};
  var nextId = 1;
  var handlers = { toolresult: [], toolinput: [], toolcancelled: [], hostcontext: [] };
  var hostContext = {};

  function post(message) {
    window.parent.postMessage(message, '*');
  }

  function request(method, params) {
    var id = nextId++;
    var promise = new Promise(function (resolve, reject) {
      pending[id] = { resolve: resolve, reject: reject };
    });
    post({ jsonrpc: '2.0', id: id, method: method, params: params });
    return promise;
  }

  function emit(event, payload) {
    for (var i = 0; i < handlers[event].length; i++) handlers[event][i](payload);
  }

  window.addEventListener('message', function (event) {
    // The package's own PostMessageTransport treats eventSource validation as
    // required (message-transport.d.ts): the host only ever targets this
    // frame's window.parent, so any other source is not the host and must be
    // ignored, not merely untrusted-but-processed.
    if (event.source !== window.parent) return;
    var message = event.data;
    if (!message || message.jsonrpc !== '2.0') return;
    if (message.id !== undefined && pending[message.id]) {
      var slot = pending[message.id];
      delete pending[message.id];
      if (message.error) slot.reject(new Error(message.error.message));
      else slot.resolve(message.result);
      return;
    }
    if (message.method === 'ui/notifications/tool-result') return emit('toolresult', message.params || {});
    if (message.method === 'ui/notifications/tool-input') return emit('toolinput', (message.params || {}).arguments || {});
    if (message.method === 'ui/notifications/tool-cancelled') return emit('toolcancelled', message.params || {});
    if (message.method === 'ui/notifications/host-context-changed') {
      var changed = message.params || {};
      for (var key in changed) hostContext[key] = changed[key];
      applyTheme();
      return emit('hostcontext', hostContext);
    }
    if (message.id !== undefined) post({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Method not found' } });
  });

  function applyTheme() {
    if (hostContext.theme === 'dark' || hostContext.theme === 'light') {
      document.documentElement.setAttribute('data-theme', hostContext.theme);
    }
  }

  function reportSize() {
    post({ jsonrpc: '2.0', method: 'ui/notifications/size-changed', params: { height: document.documentElement.scrollHeight } });
  }

  window.homeledger = {
    on: function (event, handler) {
      handlers[event].push(handler);
    },
    hostContext: function () {
      return hostContext;
    },
    callTool: function (name, args) {
      return request('tools/call', { name: name, arguments: args });
    },
    reportSize: reportSize,
    connect: function (appName) {
      return request('ui/initialize', {
        appInfo: { name: appName, version: '0.1.0' },
        appCapabilities: {},
        protocolVersion: '2026-01-26'
      }).then(function (result) {
        var context = (result && result.hostContext) || {};
        for (var key in context) hostContext[key] = context[key];
        applyTheme();
        post({ jsonrpc: '2.0', method: 'ui/notifications/initialized', params: {} });
        emit('hostcontext', hostContext);
        reportSize();
        return hostContext;
      });
    }
  };
})();
`;

/** 768 by 480 is the Alexa+ base canvas; cards are #14181E dark, #FFFFFF light. */
export const WIDGET_CSS = String.raw`
:root {
  color-scheme: light;
  --bg: #faf9fb;
  --card: #ffffff;
  --nested: #f2f1f4;
  --text: #16181d;
  --muted: #5b6070;
  --line: #dedbe4;
  --accent: #1f6feb;
  --warn: #b3541e;
}
@media (prefers-color-scheme: dark) {
  :root:not([data-theme='light']) {
    color-scheme: dark;
    --bg: #0d1015;
    --card: #14181e;
    --nested: #1b2028;
    --text: #f4f5f7;
    --muted: #a3a9b8;
    --line: #2a303a;
    --accent: #6ea8fe;
    --warn: #e8a266;
  }
}
:root[data-theme='dark'] {
  color-scheme: dark;
  --bg: #0d1015;
  --card: #14181e;
  --nested: #1b2028;
  --text: #f4f5f7;
  --muted: #a3a9b8;
  --line: #2a303a;
  --accent: #6ea8fe;
  --warn: #e8a266;
}
* { box-sizing: border-box; }
body {
  margin: 0;
  padding: 16px;
  background: var(--bg);
  color: var(--text);
  font: 15px/1.45 system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif;
}
main { max-width: 768px; margin: 0 auto; }
h1 { margin: 0 0 12px; font-size: 20px; font-weight: 600; }
.card { background: var(--card); border: 1px solid var(--line); border-radius: 12px; padding: 12px 14px; margin-bottom: 8px; }
.row { display: flex; flex-wrap: wrap; gap: 8px; align-items: baseline; justify-content: space-between; }
.name { font-weight: 600; }
.muted { color: var(--muted); font-size: 13px; }
.warn { color: var(--warn); font-weight: 600; }
.pill { background: var(--nested); border-radius: 999px; padding: 2px 10px; font-size: 12px; color: var(--muted); }
button {
  font: inherit;
  font-size: 13px;
  color: var(--card);
  background: var(--accent);
  border: 0;
  border-radius: 8px;
  padding: 6px 12px;
  cursor: pointer;
}
button[disabled] { opacity: 0.5; cursor: default; }
.empty { color: var(--muted); padding: 24px 0; text-align: center; }
`;

export function page(title: string, body: string, script: string): string {
  return [
    '<!doctype html>',
    '<html lang="en">',
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${title}</title>`,
    `<style>${WIDGET_CSS}</style>`,
    '</head>',
    '<body>',
    body,
    `<script>${BRIDGE_SCRIPT}</script>`,
    `<script>${script}</script>`,
    '</body>',
    '</html>'
  ].join('\n');
}
