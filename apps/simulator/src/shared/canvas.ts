/**
 * The published display geometry, written down once for the whole application.
 *
 * Read by `components/Frame.tsx`, which lays the canvas out at this size and
 * scales it, and by `lib/widget-host.ts`, which tells every widget these same
 * bounds in its `hostContext` so a widget sizes itself to the surface it was
 * authored against (`apps/mcp-server/src/widgets/shell.ts` is built for the
 * same 768). Deliberately here in `src/shared/` and not in the component: a
 * module under `lib/` must be able to read it without importing React, and a
 * second copy of 768 is a second thing to forget to change.
 *
 * Not in CSS either. `globals.css` declares no `--canvas-width`; the frame
 * sets the size inline from these values, so there is nothing to keep in sync
 * by hand.
 */
export const BASE_CANVAS = { width: 768, height: 480 } as const;

/** The published scale factor for the 8- and 15-inch displays. */
export const CANVAS_SCALE = 1.667;

/** Derived, never written down twice: 768 x 480 at 1.667 is 1280 x 800. */
export const DEVICE = { width: Math.round(BASE_CANVAS.width * CANVAS_SCALE), height: Math.round(BASE_CANVAS.height * CANVAS_SCALE) } as const;
