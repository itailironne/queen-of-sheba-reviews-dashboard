const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    locale: 'he-IL',
    viewport: { width: 1280, height: 2000 },
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
  });
  const page = await context.newPage();
  await page.goto('https://www.booking.com/hotel/il/eilat-queen-of-sheba.html?lang=he-il', { waitUntil: 'domcontentloaded', timeout: 45000 });
  await page.waitForTimeout(3000);

  const info = await page.evaluate(() => {
    const el = document.querySelector('[data-testid="Property-Header-Nav-Tab-Trigger-reviews"]');
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { tag: el.tagName, href: el.getAttribute('href'), rect: { x: r.x, y: r.y, w: r.width, h: r.height }, visible: r.width > 0 && r.height > 0, outerHTML: el.outerHTML.slice(0, 300) };
  });
  console.log('navTabInfo=', JSON.stringify(info, null, 2));

  // Try scrolling it into view then clicking via evaluate with dispatchEvent (bubbling mouse events)
  await page.evaluate(() => {
    const el = document.querySelector('[data-testid="Property-Header-Nav-Tab-Trigger-reviews"]');
    if (el) el.scrollIntoView();
  });
  await page.waitForTimeout(1000);
  const info2 = await page.evaluate(() => {
    const el = document.querySelector('[data-testid="Property-Header-Nav-Tab-Trigger-reviews"]');
    const r = el.getBoundingClientRect();
    return { rect: { x: r.x, y: r.y, w: r.width, h: r.height } };
  });
  console.log('after scrollIntoView=', JSON.stringify(info2));

  await browser.close();
})().catch(e => { console.error('ERR', e); process.exit(1); });
