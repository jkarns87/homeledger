import { RESOURCE_MIME_TYPE, RESOURCE_URI_META_KEY } from '@modelcontextprotocol/ext-apps/server';
import { afterEach, describe, expect, it } from 'vitest';
import { WIDGETS, WIDGET_URIS } from '../src/widgets/index.js';
import { modernClient } from './harness.js';

let close: () => Promise<void> = async () => {};
afterEach(async () => {
  await close();
});

describe('widget constants', () => {
  it('agrees with the MCP Apps SDK on the mime type and the meta key', () => {
    expect(RESOURCE_MIME_TYPE).toBe('text/html;profile=mcp-app');
    expect(RESOURCE_URI_META_KEY).toBe('ui/resourceUri');
  });

  it('declares exactly the four ui:// widgets from the design', () => {
    expect(WIDGETS.map(w => w.uri)).toEqual([WIDGET_URIS.appliances, WIDGET_URIS.appliance, WIDGET_URIS.calendar, WIDGET_URIS.visit]);
    expect(WIDGETS.map(w => w.uri)).toEqual(['ui://homeledger/appliances', 'ui://homeledger/appliance', 'ui://homeledger/calendar', 'ui://homeledger/visit']);
  });
});

describe('widget resources', () => {
  it('lists all four alongside the JSON resources', async () => {
    const h = await modernClient();
    close = h.close;
    const { resources } = await h.client.listResources();
    const uris = resources.map(r => r.uri).sort();
    expect(uris).toEqual([
      'homeledger://appliances',
      'homeledger://household',
      'homeledger://maintenance/schedule',
      'ui://homeledger/appliance',
      'ui://homeledger/appliances',
      'ui://homeledger/calendar',
      'ui://homeledger/visit'
    ]);
    for (const widget of WIDGETS) {
      expect(resources.find(r => r.uri === widget.uri)?.mimeType).toBe(RESOURCE_MIME_TYPE);
    }
  });

  it('serves self-contained, theme-aware HTML sized for a 768 by 480 canvas', async () => {
    const h = await modernClient();
    close = h.close;
    for (const widget of WIDGETS) {
      const read = await h.client.readResource({ uri: widget.uri });
      const contents = read.contents[0] as { mimeType?: string; text: string };
      expect(contents.mimeType).toBe(RESOURCE_MIME_TYPE);
      const html = contents.text;
      expect(html.startsWith('<!doctype html>')).toBe(true);
      expect(html).toContain('ui/initialize');
      expect(html).toContain('ui/notifications/tool-result');
      expect(html).toContain('prefers-color-scheme: dark');
      expect(html).toContain('768px');
      // No external assets: nothing may be fetched over the network.
      expect(/(?:src|href)\s*=\s*["']https?:/i.test(html)).toBe(false);
      expect(html).not.toContain('//fonts.googleapis.com');
    }
  });

  it('puts a log as done button on the calendar widget only', async () => {
    const h = await modernClient();
    close = h.close;
    const calendar = await h.client.readResource({ uri: WIDGET_URIS.calendar });
    expect((calendar.contents[0] as { text: string }).text).toContain('log_maintenance');
    const appliances = await h.client.readResource({ uri: WIDGET_URIS.appliances });
    expect((appliances.contents[0] as { text: string }).text).not.toContain('log_maintenance');
  });
});

describe('tool widget metadata', () => {
  it('points the five widget-backed tools at their resources through _meta.ui.resourceUri', async () => {
    const h = await modernClient();
    close = h.close;
    const { tools } = await h.client.listTools();
    const uriOf = (name: string) => {
      const meta = tools.find(t => t.name === name)?._meta as { ui?: { resourceUri?: string } } | undefined;
      return meta?.ui?.resourceUri;
    };
    expect(uriOf('list_appliances')).toBe(WIDGET_URIS.appliances);
    expect(uriOf('get_appliance')).toBe(WIDGET_URIS.appliance);
    expect(uriOf('maintenance_due')).toBe(WIDGET_URIS.calendar);
    expect(uriOf('book_service')).toBe(WIDGET_URIS.visit);
    expect(uriOf('get_visit')).toBe(WIDGET_URIS.visit);
    expect(uriOf('ask_manual')).toBeUndefined();
    expect(uriOf('log_maintenance')).toBeUndefined();
    expect(uriOf('recent_events')).toBeUndefined();
  });

  it('also sets the deprecated flat key so older hosts resolve the widget', async () => {
    const h = await modernClient();
    close = h.close;
    const { tools } = await h.client.listTools();
    const meta = tools.find(t => t.name === 'get_visit')?._meta as Record<string, unknown> | undefined;
    expect(meta?.[RESOURCE_URI_META_KEY]).toBe(WIDGET_URIS.visit);
  });
});
