import { afterEach, describe, expect, it, vi } from 'vitest';
import { BASE_CANVAS } from '../src/shared/canvas.js';
import { WIDGET_PROTOCOL_VERSION, attachWidgetHost, hostContextFor } from '../src/lib/widget-host.js';

let detach: () => void = () => {};
afterEach(() => detach());

/**
 * jsdom will not let a MessageEvent carry an arbitrary `source`, so the frame's
 * window is faked and the event is built as a plain Event with `source`
 * assigned. That keeps the source check under test rather than bypassed.
 */
function fakeFrame() {
  const posted: unknown[] = [];
  const frameWindow = { postMessage: (message: unknown) => posted.push(message) } as unknown as Window;
  const send = (data: unknown, source: unknown = frameWindow) => {
    const event = new Event('message');
    Object.assign(event, { data, source });
    window.dispatchEvent(event);
  };
  return { frameWindow, posted, send };
}

function attach(over: Partial<Parameters<typeof attachWidgetHost>[0]> = {}) {
  const frame = fakeFrame();
  const callTool = vi.fn(async () => ({ structuredContent: { nextDueAt: '2027-01-04' } }));
  const handle = attachWidgetHost({
    frameWindow: frame.frameWindow,
    hostContext: () => hostContextFor('dark'),
    toolResult: () => ({ content: [{ type: 'text', text: 'Two tasks are due.' }], structuredContent: { items: [{ applianceId: 'appl_x' }] } }),
    callTool,
    ...over
  });
  detach = handle.detach;
  return { ...frame, callTool, handle };
}

describe('attachWidgetHost', () => {
  it('answers ui/initialize with the host context the widget reads its theme from', () => {
    const { posted, send } = attach();
    send({ jsonrpc: '2.0', id: 1, method: 'ui/initialize', params: { appInfo: { name: 'homeledger-calendar', version: '0.1.0' } } });
    expect(posted).toHaveLength(1);
    const reply = posted[0] as { id: number; result: { protocolVersion: string; hostContext: { theme: string; maxWidth: number; maxHeight: number } } };
    expect(reply.id).toBe(1);
    expect(reply.result.protocolVersion).toBe(WIDGET_PROTOCOL_VERSION);
    expect(reply.result.hostContext.theme).toBe('dark');
    // The base canvas, so a widget laying itself out to the host's bounds gets
    // the same 768x480 it was authored against - and NOT the 1280x800 device,
    // which is that canvas already scaled. Written as literals here on
    // purpose: `expect(...).toBe(BASE_CANVAS.width)` would be the same module
    // agreeing with itself, and would pass after someone changed the constant.
    // The link to `src/shared/canvas.ts` is proved by Task 10's mutation 7,
    // which changes BASE_CANVAS once and requires BOTH suites to fail.
    expect(reply.result.hostContext.maxWidth).toBe(768);
    expect(reply.result.hostContext.maxHeight).toBe(480);
    expect(BASE_CANVAS.width).toBe(768);
  });

  it('pushes the tool result once the widget says it is initialised, not before', () => {
    const { posted, send } = attach();
    send({ jsonrpc: '2.0', id: 1, method: 'ui/initialize', params: {} });
    expect(posted.filter(m => (m as { method?: string }).method === 'ui/notifications/tool-result')).toHaveLength(0);
    send({ jsonrpc: '2.0', method: 'ui/notifications/initialized', params: {} });
    const pushed = posted.find(m => (m as { method?: string }).method === 'ui/notifications/tool-result') as { params: { structuredContent: unknown } };
    expect(pushed.params.structuredContent).toEqual({ items: [{ applianceId: 'appl_x' }] });
  });

  it('runs a tools/call from the widget and replies to its id', async () => {
    const { posted, send, callTool } = attach();
    send({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'log_maintenance', arguments: { applianceId: 'appl_x', taskType: 'filter' } } });
    await vi.waitFor(() => expect(posted.some(m => (m as { id?: number }).id === 7)).toBe(true));
    expect(callTool).toHaveBeenCalledWith('log_maintenance', { applianceId: 'appl_x', taskType: 'filter' });
    expect(posted.find(m => (m as { id?: number }).id === 7)).toEqual({ jsonrpc: '2.0', id: 7, result: { structuredContent: { nextDueAt: '2027-01-04' } } });
  });

  it('replies with an error, not silence, when a tools/call fails', async () => {
    const { posted, send } = attach({ callTool: async () => Promise.reject(new Error('log_maintenance is not allowed from a widget')) });
    send({ jsonrpc: '2.0', id: 8, method: 'tools/call', params: { name: 'book_service', arguments: {} } });
    await vi.waitFor(() => expect(posted.some(m => (m as { id?: number }).id === 8)).toBe(true));
    const reply = posted.find(m => (m as { id?: number }).id === 8) as { error: { code: number; message: string } };
    expect(reply.error.code).toBe(-32603);
    expect(reply.error.message).toContain('not allowed from a widget');
  });

  it('answers an unknown request method rather than leaving the widget waiting', () => {
    const { posted, send } = attach();
    send({ jsonrpc: '2.0', id: 9, method: 'ui/teleport', params: {} });
    expect(posted.find(m => (m as { id?: number }).id === 9)).toEqual({ jsonrpc: '2.0', id: 9, error: { code: -32601, message: 'Method not found' } });
  });

  it('reports a size change to the host', () => {
    const onSize = vi.fn();
    const { send } = attach({ onSize });
    send({ jsonrpc: '2.0', method: 'ui/notifications/size-changed', params: { height: 312 } });
    expect(onSize).toHaveBeenCalledWith(312);
  });

  it('ignores a message from any window that is not this frame', () => {
    const { posted, send } = attach();
    send({ jsonrpc: '2.0', id: 1, method: 'ui/initialize', params: {} }, { postMessage: () => {} });
    expect(posted).toHaveLength(0);
  });

  it('ignores a message that is not JSON-RPC', () => {
    const { posted, send } = attach();
    send({ hello: 'there' });
    send(null);
    send('a string');
    expect(posted).toHaveLength(0);
  });

  it('pushes only the changed fields when the theme is toggled', () => {
    const { posted, send, handle } = attach();
    send({ jsonrpc: '2.0', id: 1, method: 'ui/initialize', params: {} });
    handle.pushHostContext({ theme: 'light' });
    const changed = posted.find(m => (m as { method?: string }).method === 'ui/notifications/host-context-changed') as { params: Record<string, unknown> };
    expect(changed.params).toEqual({ theme: 'light' });
  });

  it('stops listening after detach', () => {
    const { posted, send, handle } = attach();
    handle.detach();
    send({ jsonrpc: '2.0', id: 1, method: 'ui/initialize', params: {} });
    expect(posted).toHaveLength(0);
  });
});
