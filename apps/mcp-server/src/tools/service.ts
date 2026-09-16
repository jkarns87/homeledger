import { acceptedContent, inputRequired, type McpServer, type RequestStateCodec, type ServerContext } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import { VisitStatus, derivedId, providersForCategory } from '@homeledger/core';
import { booleanField, elicitOutcome, enumField } from '../elicit.js';
import { runAvailabilityCheck } from '../progress.js';
import type { ServerDeps } from '../server.js';
import { speakWeekdayDate } from '../voice.js';

/** Cross-round booking state, carried in the signed requestState. */
export interface BookingState {
  applianceId: string;
  issue: string;
  providerId?: string;
  windowStart?: string;
  windowEnd?: string;
}

export interface ServiceWindow {
  id: string;
  start: string;
  end: string;
  label: string;
}

const WINDOW_DAY_OFFSETS = [2, 3, 4];

/**
 * Three 1-to-3 PM UTC windows, two to four days out from the current date.
 * Deterministic so tests can assert exact timestamps. Labels read in UTC;
 * localising to the household timezone is Plan 3's simulator concern.
 */
export function availabilityWindows(nowIso: string): ServiceWindow[] {
  const base = new Date(`${nowIso.slice(0, 10)}T00:00:00Z`).getTime();
  return WINDOW_DAY_OFFSETS.map((offset, index) => {
    const day = new Date(base + offset * 86_400_000).toISOString().slice(0, 10);
    return {
      id: `win_${index + 1}`,
      start: `${day}T13:00:00.000Z`,
      end: `${day}T15:00:00.000Z`,
      label: `${speakWeekdayDate(day)}, 1 to 3 PM`
    };
  });
}

const ProviderAnswer = z.object({ provider: z.string() });
const WindowAnswer = z.object({ window: z.string() });
const ConfirmAnswer = z.object({ confirm: z.boolean() });

const notBooked = () => ({ content: [{ type: 'text' as const, text: "Okay, I haven't booked anything." }], isError: true });

export function registerServiceTools(server: McpServer, deps: ServerDeps, codec: RequestStateCodec<BookingState>): void {
  server.registerTool(
    'book_service',
    {
      title: 'Book a service visit',
      description:
        'Book a service visit for an appliance. Asks which provider to use, which arrival window to take, and for a final confirmation before anything is written. Providers come from a sample marketplace, not a real booking network.',
      inputSchema: z.object({ applianceId: z.string(), issue: z.string().min(3).max(300), preferredWindow: z.string().max(100).optional() }),
      outputSchema: z.object({
        visitId: z.string(),
        provider: z.string(),
        windowStart: z.string(),
        windowEnd: z.string(),
        status: VisitStatus
      })
    },
    async ({ applianceId, issue }, ctx: ServerContext) => {
      const appliance = await deps.repo.getAppliance(applianceId);
      if (!appliance) return { content: [{ type: 'text', text: "I couldn't find that appliance." }], isError: true };

      const carried = ctx.mcpReq.requestState<BookingState>();
      // requestState round-trips through the client. It is integrity-checked
      // by the codec before the handler runs, but a state minted for another
      // appliance is still wrong for this call, so start over rather than mix.
      const state: BookingState = carried && carried.applianceId === applianceId ? { ...carried } : { applianceId, issue };

      const providers = providersForCategory(appliance.category);
      const applianceWords = appliance.name.toLowerCase();

      if (!state.providerId) {
        if (elicitOutcome(ctx.mcpReq.inputResponses, 'provider') === 'declined') return notBooked();
        const answer = acceptedContent(ctx.mcpReq.inputResponses, 'provider', ProviderAnswer);
        const chosen = answer ? providers.find(p => p.id === answer.provider) : undefined;
        if (!chosen) {
          return inputRequired({
            inputRequests: {
              provider: inputRequired.elicit({
                message: `Who should I book for the ${applianceWords}?`,
                requestedSchema: enumField(
                  'provider',
                  'Provider',
                  providers.map(p => p.id),
                  providers.map(p => `${p.name}, rated ${p.rating.toFixed(1)}`)
                )
              })
            },
            requestState: await codec.mint({ applianceId, issue }, ctx)
          });
        }
        state.providerId = chosen.id;
      }

      const provider = providers.find(p => p.id === state.providerId);
      if (!provider) return notBooked();

      const windows = availabilityWindows(deps.now());

      if (!state.windowStart) {
        if (elicitOutcome(ctx.mcpReq.inputResponses, 'window') === 'declined') return notBooked();
        const answer = acceptedContent(ctx.mcpReq.inputResponses, 'window', WindowAnswer);
        const chosen = answer ? windows.find(w => w.id === answer.window) : undefined;
        if (!chosen) {
          await runAvailabilityCheck(ctx, deps.availabilityDelayMs, provider.name);
          return inputRequired({
            inputRequests: {
              window: inputRequired.elicit({
                message: `${provider.name} has three windows. Which one works?`,
                requestedSchema: enumField(
                  'window',
                  'Arrival window',
                  windows.map(w => w.id),
                  windows.map(w => w.label)
                )
              })
            },
            requestState: await codec.mint({ applianceId, issue, providerId: provider.id }, ctx)
          });
        }
        state.windowStart = chosen.start;
        state.windowEnd = chosen.end;
      }

      const window = windows.find(w => w.start === state.windowStart);
      if (!window) return notBooked();

      if (elicitOutcome(ctx.mcpReq.inputResponses, 'confirm') === 'declined') return notBooked();
      const confirmed = acceptedContent(ctx.mcpReq.inputResponses, 'confirm', ConfirmAnswer);
      if (!confirmed) {
        return inputRequired({
          inputRequests: {
            confirm: inputRequired.elicit({
              message: `Book ${provider.name} for ${window.label}?`,
              requestedSchema: booleanField('confirm', 'Confirm booking')
            })
          },
          requestState: await codec.mint({ applianceId, issue, providerId: provider.id, windowStart: window.start, windowEnd: window.end }, ctx)
        });
      }
      if (!confirmed.confirm) return notBooked();

      // Deterministic, not random: a client retry of this exact confirm round
      // (an ordinary network retry, not just a hostile replay) must produce
      // the SAME visit id so the write overwrites the prior attempt's row
      // (Repository.putVisit is replace-by-id) instead of double-booking.
      // Household id is included so this stays correct if multi-household
      // ever lands, even though there is only one household today.
      const household = await deps.repo.getHousehold();
      const visitId = derivedId('visit', `${household?.id ?? ''}\u0000${applianceId}\u0000${provider.id}\u0000${window.start}`);
      await deps.repo.putVisit({
        id: visitId,
        providerId: provider.id,
        providerName: provider.name,
        category: appliance.category,
        applianceId,
        issue: state.issue,
        windowStart: window.start,
        windowEnd: window.end,
        status: 'scheduled',
        ringEventIds: [],
        snapshotKey: null,
        description: null,
        arrivedAt: null,
        createdAt: deps.now()
      });

      return {
        content: [{ type: 'text', text: `Booked ${provider.name} for ${window.label}.` }],
        structuredContent: { visitId, provider: provider.name, windowStart: window.start, windowEnd: window.end, status: 'scheduled' as const }
      };
    }
  );

  server.registerTool(
    'get_visit',
    {
      title: 'Get a service visit',
      description:
        'Details for one scheduled or past service visit: who is coming, for which appliance, in which window, and whether they have arrived. Includes a doorbell snapshot and a one-line description once the visit has been matched to a door event.',
      inputSchema: z.object({ visitId: z.string() }),
      outputSchema: z.object({
        visit: z.object({
          id: z.string(),
          providerName: z.string(),
          applianceId: z.string(),
          applianceName: z.string(),
          issue: z.string(),
          windowStart: z.string(),
          windowEnd: z.string(),
          status: VisitStatus,
          arrivedAt: z.string().nullable()
        }),
        snapshotUrl: z.string().nullable(),
        description: z.string().nullable()
      }),
      annotations: { readOnlyHint: true }
    },
    async ({ visitId }) => {
      const visit = await deps.repo.getVisit(visitId);
      if (!visit) return { content: [{ type: 'text', text: "I couldn't find that visit." }], isError: true };
      const appliance = await deps.repo.getAppliance(visit.applianceId);
      const applianceName = appliance?.name ?? 'appliance';
      const applianceWords = applianceName.toLowerCase();
      const day = speakWeekdayDate(visit.windowStart.slice(0, 10));
      const spoken =
        visit.status === 'scheduled'
          ? `${visit.providerName} is scheduled for the ${applianceWords} on ${day}, 1 to 3 PM.`
          : `${visit.providerName} ${visit.status} for the ${applianceWords} on ${day}.`;
      return {
        content: [{ type: 'text', text: spoken }],
        structuredContent: {
          visit: {
            id: visit.id,
            providerName: visit.providerName,
            applianceId: visit.applianceId,
            applianceName,
            issue: visit.issue,
            windowStart: visit.windowStart,
            windowEnd: visit.windowEnd,
            status: visit.status,
            arrivedAt: visit.arrivedAt
          },
          // Both filled in by the Ring plan: snapshotUrl from a short-TTL
          // presign of visit.snapshotKey, description from the Nova vision
          // sentence. Always present, always null until then.
          snapshotUrl: null,
          description: visit.description
        }
      };
    }
  );
}
