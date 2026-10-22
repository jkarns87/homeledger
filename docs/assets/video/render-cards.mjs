// Renders each .card in cards.html to a 1920x1080 PNG beside it.
// Run from the repo root: node docs/assets/video/render-cards.mjs
// Cards with class "clear" get a transparent background (lower-third captions).
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
// Playwright is a dependency of the simulator only; resolve it from there.
const { chromium } = createRequire(path.join(here, '../../../apps/simulator/package.json'))('@playwright/test');
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
await page.goto('file://' + path.join(here, 'cards.html'));
// The grey page background is only for previewing; captions must render on nothing.
await page.addStyleTag({ content: 'html,body{background:transparent!important}' });
for (const card of await page.locator('.card').all()) {
  const id = await card.getAttribute('id');
  const clear = (await card.getAttribute('class')).includes('clear');
  await card.screenshot({ path: path.join(here, `${id}.png`), omitBackground: clear });
  console.log(`${id}.png`);
}
await browser.close();
