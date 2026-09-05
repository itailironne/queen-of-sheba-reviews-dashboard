// Test suite for the reviews dashboard.
//   node scripts/test.js
// Covers: theme-matching correctness (both directions), data integrity,
// parser behaviour on real edge cases, and a headless render of every tab.
// Exits non-zero on any failure so the daily routine can gate on it.

const fs = require('fs');
const path = require('path');
const http = require('http');
const { findThemeMatches, tagThemes, parseRelativeDays, parseSnapshot, parseReviews } = require('./lib/parse');

const ROOT = path.join(__dirname, '..');
let passed = 0;
const failures = [];

function check(name, cond, detail) {
  if (cond) { passed++; } else { failures.push(name + (detail ? ` — ${detail}` : '')); }
}

/* ---------------- 1. theme matching, both directions ---------------- */
// Each case is a real misclassification we hit, or the legitimate match that
// a naive fix would break. Both directions matter: over-strict matching that
// drops "בבריכה" is as wrong as matching "נקי" inside "ענקיות".
const THEME_CASES = [
  ['ארוחות ענקיות וטעימות', 'cleanliness', false, 'ענקיות = giant, not clean'],
  ['סוויטה ענקית וממורקת', 'cleanliness', false, 'ענקית = giant'],
  ['החדרים היו נקיים מאוד', 'cleanliness', true, 'נקיים'],
  ['רמת נקיון גבוהה', 'cleanliness', true, 'נקיון'],
  ['זו לא הסיבה העיקרית', 'value_price', false, 'העיקרית = main'],
  ['בעיקר טעם רע', 'value_price', false, 'בעיקר = mainly'],
  ['מלון יקר מדי', 'value_price', true, 'יקר'],
  ['שווה כל שקל', 'value_price', true, 'שקל'],
  ['תמיד הולך על החיובי', 'billing', false, 'חיובי = positive'],
  ['חייבו את הכרטיס שלי', 'billing', true, 'חייבו'],
  ['מבטיח להעלות תמונות', 'value_price', false, 'להעלות = upload'],
  ['בבריכה היה נעים', 'pool', true, 'prefix ב'],
  ['מהשירות התאכזבתי', 'staff_service', true, 'prefix מה'],
  ['והצוות היה נהדר', 'staff_service', true, 'prefix ו'],
  ['ארוחת בוקר עשירה', 'food', true, 'ארוחת בוקר'],
  ['המזגן עשה רעש נורא', 'noise_ac', true, 'מזגן + רעש'],
];
for (const [text, theme, want, why] of THEME_CASES) {
  const got = findThemeMatches(text, theme).length > 0;
  check(`theme "${theme}" on "${text}" (${why})`, got === want, `expected ${want}, got ${got}`);
}

// every highlighted match must actually be inside the text at the reported offset
const sample = 'החדר לא היה נקי, והמזגן עשה רעש, אבל הבריכה מצוינת';
for (const theme of ['cleanliness', 'noise_ac', 'pool']) {
  for (const m of findThemeMatches(sample, theme)) {
    check(`offset integrity ${theme}/${m.keyword}`,
      sample.substr(m.index, m.length) === m.keyword,
      `got "${sample.substr(m.index, m.length)}"`);
  }
}

/* ---------------- 2. parser units ---------------- */
check('relative date: 12 שעות -> 0', parseRelativeDays('12 שעות') === 0);
check('relative date: יומיים -> 2', parseRelativeDays('יומיים') === 2);
check('relative date: 3 שבועות -> 21', parseRelativeDays('3 שבועות') === 21);
check('relative date: חודשיים -> 60', parseRelativeDays('חודשיים') === 60);
check('relative date: garbage -> null', parseRelativeDays('בלה בלה') === null);

// the page footer must never leak into a review body (regression: 2026-09-05)
const footerDump = [
  'דני בודק', 'לפני יום באתר  Google', '5/5', 'ביקורת אמיתית כאן',
  'מלון מלכת שבא', '‏1,106 ‏₪', '5–6 בספט׳', 'הצגת מחירים',
].join('\n');
const parsedFooter = parseReviews(footerDump, '2026-09-05');
check('footer is not swallowed into review text',
  parsedFooter.length === 1 && !/מלכת שבא|₪|הצגת מחירים/.test(parsedFooter[0].text),
  JSON.stringify(parsedFooter[0] && parsedFooter[0].text));

/* ---------------- 3. stored data integrity ---------------- */
const reviews = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/reviews.json'), 'utf8'));
const snapshots = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/snapshots.json'), 'utf8'));
const today = new Date().toISOString().slice(0, 10);

check('reviews is a non-empty array', Array.isArray(reviews) && reviews.length > 0);
check('review ids are unique', new Set(reviews.map(r => r.id)).size === reviews.length);
check('every rating is 1..5', reviews.every(r => r.rating >= 1 && r.rating <= 5));
check('every source is known', reviews.every(r => ['Google', 'Booking'].includes(r.source)));
check('every review has an ISO date', reviews.every(r => /^\d{4}-\d{2}-\d{2}$/.test(r.posted_date_estimate || r.first_scraped_date || '')));
check('no future-dated reviews', reviews.every(r => (r.posted_date_estimate || today) <= today));
check('themes is always an array', reviews.every(r => Array.isArray(r.themes)));
check('stored tags match current rules', reviews.every(r => {
  const expect = tagThemes(r.text || '').sort();
  return JSON.stringify([...r.themes].sort()) === JSON.stringify(expect);
}), 'run the re-tag migration');
check('snapshot dates unique + sorted', (() => {
  const d = snapshots.map(s => s.date);
  return new Set(d).size === d.length && JSON.stringify(d) === JSON.stringify([...d].sort());
})());

/* ---------------- 4. headless render of every tab ---------------- */
async function renderTests() {
  let chromium;
  try { ({ chromium } = require('playwright')); }
  catch (e) { console.log('(playwright unavailable — skipping render tests)'); return; }

  const server = http.createServer((req, res) => {
    let p = decodeURIComponent(req.url.split('?')[0]);
    if (p === '/') p = '/reviews_dashboard.html';
    fs.readFile(path.join(ROOT, p), (err, data) => {
      if (err) { res.writeHead(404); res.end(); return; }
      const type = path.extname(p) === '.json' ? 'application/json' : 'text/html';
      res.writeHead(200, { 'Content-Type': type + '; charset=utf-8' });
      res.end(data);
    });
  });
  await new Promise(r => server.listen(8955, r));

  const browser = await chromium.launch();
  try {
    for (const [label, viewport] of [['desktop', { width: 1440, height: 900 }], ['mobile', { width: 390, height: 844 }]]) {
      const page = await browser.newPage({ viewport });
      const errors = [];
      page.on('pageerror', e => errors.push(e.message));
      page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
      await page.goto('http://localhost:8955/reviews_dashboard.html', { waitUntil: 'networkidle' });
      await page.waitForTimeout(600);

      for (const tab of ['overview', 'urgent', 'themes', 'reviews', 'howto']) {
        await page.click(`.view-tab[data-tab="${tab}"]`);
        await page.waitForTimeout(350);
        const shown = await page.evaluate(t => document.querySelector('.tab-panel.active').id === 'tab-' + t, tab);
        check(`${label}: tab "${tab}" renders`, shown);
      }
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
      check(`${label}: no horizontal overflow`, !overflow);

      // the drill-down must actually filter
      await page.click('.view-tab[data-tab="themes"]');
      await page.waitForTimeout(350);
      await page.click('.theme-card .theme-all');
      await page.waitForTimeout(500);
      const drill = await page.evaluate(() => ({
        tab: document.querySelector('.tab-panel.active').id,
        // filters are always-visible chips/segments now, not <select> elements
        theme: (document.querySelector('#themeChips .chip.active') || {}).dataset?.val,
        rows: document.querySelectorAll('#reviewsTable tbody tr').length,
      }));
      check(`${label}: theme drill-down filters`, drill.tab === 'tab-reviews' && !!drill.theme && drill.rows > 0, JSON.stringify(drill));

      // every filter control is on screen without opening anything
      const controls = await page.evaluate(() => ({
        selects: document.querySelectorAll('#tab-reviews select').length,
        segs: document.querySelectorAll('.filter-panel .seg').length,
        chips: document.querySelectorAll('#themeChips .chip').length,
      }));
      check(`${label}: review filters are expanded, not dropdowns`,
        controls.selects === 0 && controls.segs === 3 && controls.chips > 5, JSON.stringify(controls));

      // Row heights ranged 60px..1366px before the text clamp — one long review
      // stretched a row and stranded every other column above blank space.
      await page.click('.view-tab[data-tab="reviews"]');
      await page.waitForTimeout(400);
      const layout = await page.evaluate(() => {
        const rows = [...document.querySelectorAll('#reviewsTable tbody tr')];
        const hs = rows.map(r => r.getBoundingClientRect().height);
        return { rows: rows.length, max: Math.max(...hs), min: Math.min(...hs) };
      });
      // Assert the ratio, not an absolute height: on mobile each row is a
      // stacked card and is legitimately tall. The defect was the SPREAD —
      // 60px next to 1366px, a 23x range.
      check(`${label}: review row heights stay consistent`, (layout.max / layout.min) <= 6,
        `${Math.round(layout.max / layout.min)}x spread — ${JSON.stringify(layout)}`);
      check(`${label}: review list is paged, not all at once`, layout.rows <= 40, JSON.stringify(layout));

      check(`${label}: no console/page errors`, errors.length === 0, errors.slice(0, 2).join(' | '));
      await page.close();
    }
  } finally {
    await browser.close();
    server.close();
  }
}

renderTests().then(() => {
  console.log(`\n${passed} passed, ${failures.length} failed`);
  if (failures.length) {
    console.log('\nFAILURES:');
    failures.forEach(f => console.log('  ✗ ' + f));
    process.exit(1);
  }
  console.log('✓ all checks passed');
}).catch(e => { console.error('test harness error:', e); process.exit(1); });
