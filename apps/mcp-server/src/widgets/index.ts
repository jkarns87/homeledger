import { RESOURCE_URI_META_KEY } from '@modelcontextprotocol/ext-apps/server';
import { APPLIANCES_WIDGET_HTML } from './appliances.js';
import { APPLIANCE_WIDGET_HTML } from './appliance.js';
import { CALENDAR_WIDGET_HTML } from './calendar.js';
import { VISIT_WIDGET_HTML } from './visit.js';

export const WIDGET_URIS = {
  appliances: 'ui://homeledger/appliances',
  appliance: 'ui://homeledger/appliance',
  calendar: 'ui://homeledger/calendar',
  visit: 'ui://homeledger/visit'
} as const;

export interface WidgetDefinition {
  name: string;
  uri: string;
  title: string;
  description: string;
  html: string;
}

export const WIDGETS: WidgetDefinition[] = [
  {
    name: 'appliances-widget',
    uri: WIDGET_URIS.appliances,
    title: 'Appliances',
    description: 'Every household appliance with its warranty state.',
    html: APPLIANCES_WIDGET_HTML
  },
  {
    name: 'appliance-widget',
    uri: WIDGET_URIS.appliance,
    title: 'Appliance',
    description: 'One appliance with its maintenance tasks and due dates.',
    html: APPLIANCE_WIDGET_HTML
  },
  {
    name: 'calendar-widget',
    uri: WIDGET_URIS.calendar,
    title: 'Maintenance calendar',
    description: 'Maintenance due, with a log-as-done action per task.',
    html: CALENDAR_WIDGET_HTML
  },
  {
    name: 'visit-widget',
    uri: WIDGET_URIS.visit,
    title: 'Service visit',
    description: 'A booked service visit, with the arrival snapshot once one exists.',
    html: VISIT_WIDGET_HTML
  }
];

/**
 * Tool `_meta` naming a widget. Sets the nested `ui.resourceUri` the MCP Apps
 * spec prefers and the deprecated flat `ui/resourceUri` key older hosts read,
 * exactly as the SDK's registerAppTool helper does.
 */
export function uiMeta(resourceUri: string): Record<string, unknown> {
  return { ui: { resourceUri }, [RESOURCE_URI_META_KEY]: resourceUri };
}
