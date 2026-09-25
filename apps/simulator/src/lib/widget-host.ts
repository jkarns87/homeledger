import { BASE_CANVAS } from '../shared/canvas.js';

/** The version the widgets' own bridge sends in `ui/initialize` (`apps/mcp-server/src/widgets/shell.ts`). */
export const WIDGET_PROTOCOL_VERSION = '2026-01-26';

export interface HostContext {
  theme: 'dark' | 'light';
  displayMode: 'inline';
  /** The published base canvas, so a widget sizing itself to the host gets the bounds it was authored against. */
  maxWidth: number;
  maxHeight: number;
  locale: string;
  timeZone: string;
  userAgent: string;
  platform: 'web';
  deviceCapabilities: { touch: boolean; hover: boolean };
}

export function hostContextFor(theme: 'dark' | 'light'): HostContext {
  return {
    theme,
    displayMode: 'inline',
    // From `src/shared/canvas.ts`, not written out again. These are the bounds
    // a widget lays itself out to, and the frame lays the canvas out to the
    // same values; two copies of 768 disagree the first time one is changed,
    // and the disagreement shows up only as a widget that looks slightly
    // wrong. NOT `DEVICE`: that is this canvas already scaled, and a widget
    // told 1280 would size itself for a surface that does not exist.
    maxWidth: BASE_CANVAS.width,
    maxHeight: BASE_CANVAS.height,
    locale: 'en-US',
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    userAgent: 'homeledger-simulator/0.1.0',
    platform: 'web',
    // A smart display is touched, not hovered. The widgets do not branch on
    // this yet; it is here because it is part of the documented context and a
    // host that lies about it would be teaching the wrong thing.
    deviceCapabilities: { touch: true, hover: false }
  };
}

export interface WidgetHostOptions {
  frameWindow: Window;
  hostContext: () => HostContext;
  toolResult: () => { content: unknown; structuredContent: unknown };
  callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  onSize?: (height: number) => void;
  log?: (message: string) => void;
}

interface Incoming {
  jsonrpc?: unknown;
  id?: unknown;
  method?: unknown;
  params?: unknown;
}

/**
 * The host half of the MCP Apps view protocol, written against the widgets' own bridge.
 *
 * The contract is not guessed: `apps/mcp-server/src/widgets/shell.ts` is a
 * hand-written bridge (FL-029, because the view SDK cannot be inlined into a
 * single file without a bundler), and it is the spec this satisfies — the same
 * method names, the same `result.hostContext`, the same source check. If the
 * two drift, the widgets show "Waiting for the appliance list" forever and
 * nothing errors, which is why the tests here assert the wire shape rather than
 * a rendered outcome.
 */
export function attachWidgetHost(options: WidgetHostOptions): { detach: () => void; pushHostContext: (partial: Partial<HostContext>) => void } {
  const post = (message: unknown): void => options.frameWindow.postMessage(message, '*');

  const listener = (event: Event): void => {
    // The frame is sandboxed without `allow-same-origin`, so its origin is
    // opaque and an origin check would compare against "null". Identity of the
    // sending window is the check that means something, and it is the mirror
    // of the view side's own `event.source !== window.parent`.
    if ((event as { source?: unknown }).source !== options.frameWindow) return;
    const message = (event as { data?: unknown }).data as Incoming | null;
    if (typeof message !== 'object' || message === null || message.jsonrpc !== '2.0') return;
    const { id, method } = message;
    const params = (typeof message.params === 'object' && message.params !== null ? message.params : {}) as Record<string, unknown>;

    if (method === 'ui/initialize' && id !== undefined) {
      post({
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: WIDGET_PROTOCOL_VERSION,
          hostInfo: { name: 'homeledger-simulator', version: '0.1.0' },
          hostContext: options.hostContext()
        }
      });
      return;
    }

    if (method === 'ui/notifications/initialized') {
      // Sent only now. A tool-result that arrives before the widget has
      // finished initialising is dropped by its own bridge, and the widget
      // then waits for a second one that never comes.
      post({ jsonrpc: '2.0', method: 'ui/notifications/tool-result', params: options.toolResult() });
      return;
    }

    if (method === 'ui/notifications/size-changed') {
      const height = params.height;
      if (typeof height === 'number') options.onSize?.(height);
      return;
    }

    if (method === 'tools/call' && id !== undefined) {
      const name = params.name;
      const args = (typeof params.arguments === 'object' && params.arguments !== null ? params.arguments : {}) as Record<string, unknown>;
      if (typeof name !== 'string') {
        post({ jsonrpc: '2.0', id, error: { code: -32602, message: 'tools/call needs a string name' } });
        return;
      }
      void options
        .callTool(name, args)
        .then(result => post({ jsonrpc: '2.0', id, result }))
        .catch((error: unknown) => post({ jsonrpc: '2.0', id, error: { code: -32603, message: error instanceof Error ? error.message : String(error) } }));
      return;
    }

    // Every remaining request gets an answer. A widget that asked something
    // and is never told no keeps a button disabled forever.
    if (id !== undefined) post({ jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found' } });
    else options.log?.(`ignored a widget notification this host does not handle: ${String(method)}`);
  };

  window.addEventListener('message', listener);
  return {
    detach: () => window.removeEventListener('message', listener),
    pushHostContext: partial => post({ jsonrpc: '2.0', method: 'ui/notifications/host-context-changed', params: partial })
  };
}
