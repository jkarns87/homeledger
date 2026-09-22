import { acceptedContent, inputRequired, type McpServer, type RequestStateCodec, type ServerContext } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import { VisitStatus, derivedId, providersForCategory } from '@homeledger/core';
import { booleanField, elicitOutcome, enumField, supportsFormElicitation } from '../elicit.js';
import { runAvailabilityCheck } from '../progress.js';
import type { ServerDeps } from '../server.js';
import { speakZonedDay, speakZonedInstant, speakZonedWindow } from '../voice.js';
import { WIDGET_URIS, uiMeta } from '../widgets/index.js';

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
 * Three two-hour windows, two to four days out. The instants are UTC and
 * unchanged - 13:00Z to 15:00Z, deterministic so tests can assert exact
 * timestamps, and exactly what gets written to DynamoDB. Only the LABEL moved:
 * it used to read the UTC wall clock back as if it were the household's ("1 to
 * 3 PM"), which is how a person in a kitchen in Illinois was told 1 PM for a
 * visit their own clock calls 8 AM. The label now renders those same instants
 * in `zone`, with the abbreviation, so the spoken window, the elicitation
 * option, the confirmation and the widget all say one thing.
 */
export function availabilityWindows(nowIso: string, zone: string): ServiceWindow[] {
  const base = new Date(`${nowIso.slice(0, 10)}T00:00:00Z`).getTime();
  return WINDOW_DAY_OFFSETS.map((offset, index) => {
    const day = new Date(base + offset * 86_400_000).toISOString().slice(0, 10);
    const start = `${day}T13:00:00.000Z`;
    const end = `${day}T15:00:00.000Z`;
    return { id: `win_${index + 1}`, start, end, label: speakZonedWindow(start, end, zone) };
  });
}

const ProviderAnswer = z.object({ provider: z.string() });
const WindowAnswer = z.object({ window: z.string() });
const ConfirmAnswer = z.object({ confirm: z.boolean() });

const notBooked = () => ({ content: [{ type: 'text' as const, text: "Okay, I haven't booked anything." }], isError: true });

/**
 * What a person hears when their client cannot be asked anything.
 *
 * Prose, because every tool here is read aloud. It names the three questions by
 * what they are for rather than by protocol vocabulary, then says the one thing
 * the person can act on: a different client. Claude Code gates elicitation
 * behind `tengu_mcp_elicitation`, a remote feature flag that defaults to FALSE
 * (FL-033), so this is the DEFAULT experience for most people who add this
 * server — not an edge case.
 */
export const BOOKING_NEEDS_ELICITATION_MESSAGE =
  "I can't book a service visit from this app. Booking has to ask you three things first, which provider to send, which arrival window to take, and whether to go ahead, and this app can't show me those questions. Everything else still works. To book, come back from an app that can prompt you for answers.";

const cannotAskAnything = () => ({ content: [{ type: 'text' as const, text: BOOKING_NEEDS_ELICITATION_MESSAGE }], isError: true });

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
        // The window as a person reads it, rendered server-side in the
        // household's zone. Nullable-never, always present: the visit widget
        // has no way of its own to know the household's zone, and letting it
        // format `windowStart` itself would put the VIEWER's clock on a shared
        // kitchen display - the one thing this must not do. One rendering,
        // computed once, spoken and shown identically.
        windowLabel: z.string(),
        status: VisitStatus
      }),
      _meta: uiMeta(WIDGET_URIS.visit)
    },
    async ({ applianceId, issue }, ctx: ServerContext) => {
      // Checked before anything else, including the appliance lookup, because
      // it is a precondition on the CLIENT rather than on the arguments: every
      // path through this handler reaches at least the confirm question, so a
      // client that cannot be asked cannot complete a booking under any input.
      //
      // Answering here rather than letting the SDK's own gate fire is the whole
      // point. On the 2026-07-28 path that gate throws
      // MissingRequiredClientCapabilityError, which reaches the person as a
      // JSON-RPC -32021 and not as a tool result at all; on the 2025-era path it
      // returns protocol jargon ("Cannot request input 'provider'
      // (elicitation/create): the client on this 2025-era connection did not
      // declare the required capability"). Neither is something a person can
      // act on, and both differ by era for what is one situation.
      //
      // Deliberately NOT a degraded booking that skips the questions: writing a
      // visit without confirming the provider and the window is worse than
      // declining to write one, because the person finds out what was booked
      // when someone arrives.
      if (!supportsFormElicitation(server)) return cannotAskAnything();

      const appliance = await deps.repo.getAppliance(applianceId);
      if (!appliance) return { content: [{ type: 'text', text: "I couldn't find that appliance." }], isError: true };
      const zone = await deps.householdTimeZone();

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

      const windows = availabilityWindows(deps.now(), zone);

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
        structuredContent: {
          visitId,
          provider: provider.name,
          windowStart: window.start,
          windowEnd: window.end,
          windowLabel: window.label,
          status: 'scheduled' as const
        }
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
          // Rendered in the household's zone, alongside the raw UTC instants
          // rather than instead of them - see book_service's windowLabel.
          // `arrivedAtLabel` is null exactly when `arrivedAt` is.
          windowLabel: z.string(),
          status: VisitStatus,
          arrivedAt: z.string().nullable(),
          arrivedAtLabel: z.string().nullable()
        }),
        snapshotUrl: z.string().nullable(),
        description: z.string().nullable()
      }),
      annotations: { readOnlyHint: true },
      _meta: uiMeta(WIDGET_URIS.visit)
    },
    async ({ visitId }) => {
      const visit = await deps.repo.getVisit(visitId);
      if (!visit) return { content: [{ type: 'text', text: "I couldn't find that visit." }], isError: true };
      const appliance = await deps.repo.getAppliance(visit.applianceId);
      const applianceName = appliance?.name ?? 'appliance';
      const applianceWords = applianceName.toLowerCase();
      const zone = await deps.householdTimeZone();
      // `visit.windowStart.slice(0, 10)` - what this used to do - is the UTC
      // date of a stored instant, not the day the visit falls on in the
      // household's zone. For a window at 01:00Z those are different days, so
      // the old form could name the wrong day entirely, on top of the invented
      // "1 to 3 PM" that ignored the stored clock time.
      const windowLabel = speakZonedWindow(visit.windowStart, visit.windowEnd, zone);
      const arrivedAtLabel = visit.arrivedAt ? speakZonedInstant(visit.arrivedAt, zone) : null;
      const spoken =
        visit.status === 'scheduled'
          ? `${visit.providerName} is scheduled for the ${applianceWords} on ${windowLabel}.`
          : `${visit.providerName} ${visit.status} for the ${applianceWords} on ${speakZonedDay(visit.windowStart, zone)}.`;
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
            windowLabel,
            status: visit.status,
            arrivedAt: visit.arrivedAt,
            arrivedAtLabel
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
