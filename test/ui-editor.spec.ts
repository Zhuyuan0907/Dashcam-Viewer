import { expect, test } from '@playwright/test';

test.beforeEach(async ({context}) => {
  await context.addCookies([{name:'session_token',value:'ui-device-test-session',domain:'127.0.0.1',path:'/'}]);
});

test('editor preserves fractional drafts and supports keyboard handles on mobile', async ({page}) => {
  await page.setViewportSize({width:390,height:844});
  const errors:string[]=[]; page.on('pageerror', e=>errors.push(e.message));
  await page.goto('/trip/'+encodeURIComponent('v2|u:1|d:2|MS279WG-ui-test'));
  await page.locator('#edit-btn').click();
  await page.locator('#sel-start-input').fill('0.125');
  await page.locator('#sel-start-input').press('Tab');
  await expect(page.locator('#sel-start-input')).toHaveValue('0.125');
  await page.locator('#clip-h-in').focus();
  await page.locator('#clip-h-in').press('ArrowRight');
  await expect(page.locator('#sel-start-input')).toHaveValue('0.225');
  await page.reload(); await page.locator('#edit-btn').click();
  await expect(page.locator('#sel-start-input')).toHaveValue('0.225');
  await expect(page.locator('html')).toHaveAttribute('data-palette','harbor');
  expect(await page.evaluate(()=>document.documentElement.scrollWidth-innerWidth)).toBeLessThanOrEqual(1);
  expect(errors).toEqual([]);
});

test('all palettes apply from the shared registry', async ({page}) => {
  await page.goto('/account');
  for(const palette of ['harbor','terracotta','slate']) {
    await page.evaluate(p => (window as any).DashcamThemes.apply(p), palette);
    await expect(page.locator('html')).toHaveAttribute('data-palette',palette);
  }
});
