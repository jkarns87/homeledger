'use client';

import { useEffect, useRef, useState } from 'react';
import { attachWidgetHost, hostContextFor } from '../lib/widget-host.js';
import type { Theme } from './Frame.js';

export function WidgetFrame({ uri, content, structured, theme }: { uri: string; content: unknown; structured: unknown; theme: Theme }) {
  const ref = useRef<HTMLIFrameElement>(null);
  const [html, setHtml] = useState<string | null>(null);
  const [height, setHeight] = useState(180);
  const [failure, setFailure] = useState<string | null>(null);
  // Read through refs so the host is attached once and still sees fresh values.
  const data = useRef({ content, structured, theme });
  data.current = { content, structured, theme };

  useEffect(() => {
    let cancelled = false;
    void fetch(`/api/widget?uri=${encodeURIComponent(uri)}`)
      .then(async response => {
        if (!response.ok) throw new Error(`the widget ${uri} could not be loaded (${response.status})`);
        return response.text();
      })
      .then(value => {
        if (!cancelled) setHtml(value);
      })
      .catch((error: unknown) => {
        if (!cancelled) setFailure(error instanceof Error ? error.message : String(error));
      });
    return () => {
      cancelled = true;
    };
  }, [uri]);

  useEffect(() => {
    const frameWindow = ref.current?.contentWindow;
    if (!html || !frameWindow) return;
    const host = attachWidgetHost({
      frameWindow,
      hostContext: () => hostContextFor(data.current.theme),
      toolResult: () => ({ content: data.current.content, structuredContent: data.current.structured }),
      callTool: async (name, args) => {
        const response = await fetch('/api/widget/tool', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ name, arguments: args })
        });
        const payload: unknown = await response.json();
        if (!response.ok) throw new Error((payload as { message?: string }).message ?? `the call failed (${response.status})`);
        return payload;
      },
      onSize: next => setHeight(Math.min(Math.max(next, 80), 400))
    });
    return host.detach;
  }, [html]);

  useEffect(() => {
    const frameWindow = ref.current?.contentWindow;
    if (!html || !frameWindow) return;
    frameWindow.postMessage({ jsonrpc: '2.0', method: 'ui/notifications/host-context-changed', params: { theme } }, '*');
  }, [html, theme]);

  if (failure) return <p className="warn">{failure}</p>;
  if (!html) return <p className="muted">Loading the card…</p>;
  return (
    <iframe
      ref={ref}
      className="widget"
      data-testid={`widget-${uri}`}
      title={uri}
      srcDoc={html}
      height={height}
      // allow-scripts and nothing else. Without allow-same-origin the frame's
      // origin is opaque, so it can reach nothing of this application's; the
      // postMessage channel is its only way in or out, which is exactly the
      // isolation the MCP Apps design assumes.
      sandbox="allow-scripts"
    />
  );
}
