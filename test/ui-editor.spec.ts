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
  await page.screenshot({path:'test-results/editor-mobile.png',fullPage:true});
});

test('accepted export completes after the originating page closes',async({page,context})=>{
  await page.goto('/trip/'+encodeURIComponent('v2|u:1|d:2|MS279WG-ui-test'));
  await page.locator('#edit-btn').click();
  await page.locator('#sel-start-input').fill('0.125');await page.locator('#sel-start-input').press('Tab');
  await page.locator('#sel-end-input').fill('1.375');await page.locator('#sel-end-input').press('Tab');
  const accepted=page.waitForResponse(r=>r.url().includes('/api/trip-clips/')&&r.request().method()==='POST');
  await page.locator('#clip-export').click();const response=await accepted;expect(response.ok()).toBe(true);
  await page.close();
  let jobs:any[]=[];
  await expect.poll(async()=>{jobs=await(await context.request.get('/api/jobs')).json();return jobs.find(j=>j.type==='clip')?.status;},{timeout:30000}).toBe('succeeded');
  const clip=jobs.find(j=>j.type==='clip').result.clip;
  expect(clip.duration_sec).toBeGreaterThan(1);expect(clip.duration_sec).toBeLessThan(1.6);
  const download=await context.request.get('/api/trip-clip-download/'+clip.id);expect(download.ok()).toBe(true);
});

test('all palettes apply from the shared registry', async ({page}) => {
  await page.goto('/account');
  for(const palette of ['harbor','terracotta','slate']) {
    await page.evaluate(p => (window as any).DashcamThemes.apply(p), palette);
    await expect(page.locator('html')).toHaveAttribute('data-palette',palette);
  }
});
