import type { Page } from '@playwright/test';

export async function ask(page: Page, text: string): Promise<void> {
  await page.getByLabel('Ask about the house').fill(text);
  await page.getByRole('button', { name: 'Ask', exact: true }).click();
}
