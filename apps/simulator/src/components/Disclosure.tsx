/**
 * The two things this surface has to say about itself, always on screen.
 *
 * It says what this IS rather than naming what it is not, and that is a
 * deliberate choice: the organiser confirmed entrants cannot call the real
 * assistant at all, so putting that product's name on this chrome would claim
 * a connection that does not exist — the spec's "no logos or wordmarks" rule
 * read at its intent rather than its letter. What it must not leave out is the
 * simulated marketplace, which the spec requires disclosed and which the README
 * alone cannot cover: somebody watching a booking happen is not reading the
 * README.
 */
export const DISCLOSURE_TEXT =
  'Simulation — a smart-display surface built from published design guidance. It drives HomeLedger’s own MCP server for real; the service-provider marketplace is sample data and no booking leaves this system.';

export function Disclosure() {
  return (
    <p className="disclosure" data-testid="disclosure">
      {DISCLOSURE_TEXT}
    </p>
  );
}
