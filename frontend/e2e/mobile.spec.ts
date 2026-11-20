import { expect, test } from '@playwright/test';

test('works on a phone: map on top, planner below, no horizontal scroll', async ({ page }) => {
  await page.goto('/');
  const map = page.locator('.map-pane');
  const sidebar = page.locator('.sidebar');
  const mapBox = (await map.boundingBox())!;
  const sideBox = (await sidebar.boundingBox())!;
  expect(mapBox.y).toBeLessThan(sideBox.y);
  expect(mapBox.height).toBeGreaterThan(300);

  await page.getByRole('button', { name: 'Dallas → Chicago' }).click();
  await page.getByRole('button', { name: 'Find safest route' }).click();
  await expect(page.getByText('Recommended', { exact: true }).first()).toBeVisible();
  await expect(page.getByRole('slider', { name: 'Forecast hour after departure' })).toBeVisible();

  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
});
