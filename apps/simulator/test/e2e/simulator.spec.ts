import { expect, test } from '@playwright/test';
import { ask } from './fixtures.js';

test.beforeEach(async ({ page }) => {
  await page.goto('/');
});

test('the display is the base canvas at its published scale, and discloses itself', async ({ page }) => {
  const device = page.getByTestId('device');
  await expect(device).toHaveCSS('width', '1280px');
  await expect(device).toHaveCSS('height', '800px');
  await expect(page.getByTestId('disclosure')).toContainText('sample data');
  // This whole suite runs against HOMELEDGER_SIMULATOR_SCRIPTED_MODEL=1
  // (playwright.config.ts), so the on-screen marker session.ts/Disclosure.tsx
  // add for exactly this mode must be visible from the first paint — the
  // one place this plan proves the marker isn't only a unit-test fixture.
  await expect(page.getByTestId('scripted-marker')).toBeVisible();
  await expect(page.getByTestId('scripted-marker')).toContainText('no model is answering');
});

test('asking about appliances renders the widget, with its own script running inside the frame', async ({ page }) => {
  await ask(page, 'what appliances do we have');
  const frame = page.frameLocator('[data-testid="widget-ui://homeledger/appliances"]');
  // This assertion is the reason Playwright is here at all: the text below is
  // produced by the widget's own script from the tool result the host pushed
  // over postMessage, so it passes only if the whole view protocol worked.
  await expect(frame.locator('.card .name').first()).not.toBeEmpty();
  await expect(frame.locator('.card')).toHaveCount(6);
});

test('booking asks three questions as cards, shows progress, and ends with the visit card', async ({ page }) => {
  await ask(page, 'book a plumber for the water heater');

  const card = page.getByTestId('elicitation');
  await expect(card).toHaveAttribute('data-field', 'provider');
  await expect(card.getByTestId(/^option-/)).toHaveCount(3);
  // The composer is unusable while a question is up: a second turn would park
  // its elicitations on a stream nobody is reading.
  await expect(page.getByLabel('Ask about the house')).toBeDisabled();
  await card.getByTestId('option-prov_kettle_water').click();

  await expect(card).toHaveAttribute('data-field', 'window');
  await card.getByTestId('option-win_1').click();

  await expect(card).toHaveAttribute('data-field', 'confirm');
  await expect(page.getByRole('progressbar')).toHaveAttribute('aria-valuemax', '3');
  await card.getByRole('button', { name: /yes, book it/i }).click();

  await expect(page.getByTestId('elicitation')).toHaveCount(0);
  const visit = page.frameLocator('[data-testid="widget-ui://homeledger/visit"]');
  await expect(visit.locator('body')).toContainText('Kettle Creek Water Heaters');
  await expect(page.getByLabel('Ask about the house')).toBeEnabled();
});

test('declining a question books nothing, says so, and is not shown as a failure', async ({ page }) => {
  await ask(page, 'book a plumber for the water heater');
  await expect(page.getByTestId('elicitation')).toBeVisible();
  await page.getByRole('button', { name: /not now/i }).click();
  await expect(page.getByTestId('elicitation')).toHaveCount(0);

  // `ok`, not `failed`. Before Task 5's Step 1 the server signed this result
  // `isError: true`, so the transcript rendered "book_service failed - Nothing
  // was retrieved, so this is not an answer and not an empty one either" at
  // somebody who had simply chosen not to book - and this test asserted it.
  const row = page.locator('[data-testid^="tool-"][data-status="ok"]').last();
  await expect(row).toContainText("haven't booked anything");
  await expect(page.locator('[data-testid^="tool-"][data-status="failed"]')).toHaveCount(0);
  await expect(page.getByTestId('transcript')).not.toContainText('Nothing was retrieved');

  // book_service names the visit widget on its tool descriptor, so a declined
  // call still carries one, and the widget renders the no-visit state it
  // already has. Asserted rather than suppressed: this is what the screen
  // shows, so it is either correct and tested or wrong and worth seeing.
  const visit = page.frameLocator('[data-testid="widget-ui://homeledger/visit"]');
  await expect(visit.locator('#detail')).toContainText('No visit selected.');
});

test('a manual question against a server with no knowledge base answers from fixtures, and says nothing untrue', async ({ page }) => {
  // The local server serves SAMPLE_MANUAL_PASSAGES when KNOWLEDGE_BASE_ID is
  // unset, so this is the passing shape. The failing shape — the deployed one,
  // where retrieval is refused outright — is covered by failures.test.ts and by
  // the deployed run in Step 7.
  await ask(page, 'what does the manual say about F21');
  await expect(page.locator('[data-testid^="tool-"][data-status="ok"]')).toBeVisible();
  await expect(page.getByTestId('transcript')).not.toContainText('"passages"');
});

test('the calendar widget logs a task through the allowlisted tool', async ({ page }) => {
  await ask(page, 'what maintenance is due');
  const frame = page.frameLocator('[data-testid="widget-ui://homeledger/calendar"]');
  // NOT `getByRole('button', { name: 'Log as done' }).first()`: that locator
  // is re-evaluated on every action, filtered by the button's OWN accessible
  // name — and a successful click changes that name to 'Next <date>', which
  // drops the just-clicked button out of the match set. `.first()` then
  // silently re-binds to the NEXT still-unclicked button, so the assertion
  // below reads a sibling that was never clicked and reports no change,
  // looking exactly like a broken click. Confirmed by instrumenting the click
  // directly inside the frame: the handler fires synchronously ('Logging',
  // disabled) and the call completes correctly — the locator, not the click,
  // was the bug. `.card button` is positional and has no such coupling: DOM
  // order doesn't change when a button's own label does.
  const button = frame.locator('.card button').first();
  await button.click();

  // `apps/mcp-server/src/widgets/calendar.ts:36` writes 'Next ' + nextDueAt on
  // success and 'Logged' when the server sent no next date. The assertion this
  // replaces was `toContainText('Next 20')`, which matches any date in the
  // years 2000-2099 - so the only thing it could actually detect was the word
  // 'Logged'. A whole ISO date, in the future, is the shape a real round trip
  // produces: a task logged today gets its next occurrence one interval out.
  await expect(button).toHaveText(/^Next \d{4}-\d{2}-\d{2}$/);
  const nextDueAt = /^Next (\d{4}-\d{2}-\d{2})$/.exec((await button.textContent()) ?? '')?.[1];
  expect(nextDueAt).toBeTruthy();
  expect(Date.parse(`${nextDueAt}T00:00:00Z`)).toBeGreaterThan(Date.now());
});
