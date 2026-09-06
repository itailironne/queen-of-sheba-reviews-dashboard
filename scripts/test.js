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

/* ---------------- 3b. outbound source links ---------------- */
// "Open at source" pointed at placeid=ChIJgYAL-sJxABURQlYPC-ji3IQ, which is a
// different Eilat business ("purple"), so readers were sent to the wrong
// company. Nothing in the suite noticed, because nothing looked at the links.
// These assert shape only — the suite must not depend on the network — but
// shape is what was wrong: a stale id and a fragment the SPA ignores.
const dashHtml = fs.readFileSync(path.join(ROOT, 'reviews_dashboard.html'), 'utf8');
// Comments stripped: the id is named in a comment on purpose, documenting why
// it must never come back. Only live code should be searched for it.
const dashCode = dashHtml.split('\n').filter(l => !/^\s*(\/\/|\*|<!--)/.test(l)).join('\n');
check('no stale Google place id remains', !/ChIJgYAL-sJxABURQlYPC-ji3IQ/.test(dashCode),
  'that id resolves to a different business');
check('Google source link targets this hotel entity',
  /google\.com\/travel\/hotels\/entity\/CgoIytfkyoX724ETEAE\/reviews/.test(dashHtml));
check('Google map link uses the verified CID', /cid=\$\{GOOGLE_MAPS_CID\}/.test(dashHtml) && /GOOGLE_MAPS_CID = '1370061686653397962'/.test(dashHtml));
// The fragment alone leaves Booking on the overview tab with no reviews shown.
check('Booking source link opens the reviews tab, not just the fragment',
  /eilat-queen-of-sheba\.he\.html\?tab=reviews/.test(dashHtml));
check('no monday.com tokens survive the redesign', !/monday.com|Figtree|#0073ea|#f6f7fb|#d0d4e4/.test(dashHtml));
check('Apple type stack is declared', /-apple-system, BlinkMacSystemFont/.test(dashHtml));
check('no source link still relies on the bare #tab-reviews fragment',
  !/eilat-queen-of-sheba\.html\?lang=he-il#tab-reviews/.test(dashHtml));

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

      for (const tab of ['overview', 'urgent', 'themes', 'staff', 'reviews', 'howto']) {
        await page.click(`.view-tab[data-tab="${tab}"]`);
        await page.waitForTimeout(350);
        const shown = await page.evaluate(t => document.querySelector('.tab-panel.active').id === 'tab-' + t, tab);
        check(`${label}: tab "${tab}" renders`, shown);
      }
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
      check(`${label}: no horizontal overflow`, !overflow);
      // Design-system invariants. The look is a system, not a coat of paint:
       // each of these is a rule the spec states outright, and each is the kind
      // of thing that decays silently one component at a time.
      const design = await page.evaluate(() => {
        const cs = el => el && getComputedStyle(el);
        const shadowed = [...document.querySelectorAll(".widget, .kpi, .filter-panel, button, .chip")]
          .filter(el => { const s = getComputedStyle(el).boxShadow; return s && s !== "none"; })
          .map(el => el.className || el.tagName).slice(0, 4);
        // Only Action Blue may fill a selected control — no second accent.
        const accents = [...new Set([...document.querySelectorAll(".view-tab.active, .seg button.active, .chip.active")]
          .map(el => getComputedStyle(el).backgroundColor))];
        return {
          body: cs(document.body).fontSize,
          navBg: cs(document.querySelector(".global-nav")).backgroundColor,
          cardRadius: cs(document.querySelector(".widget")).borderRadius,
          tabRadius: cs(document.querySelector(".view-tab")).borderRadius,
          shadowed, accents,
          sidebarGone: !document.querySelector(".sidebar"),
        };
      });
      check(`${label}: body copy runs at 17px`, design.body === "17px", design.body);
      check(`${label}: global nav is true black`, design.navBg === "rgb(0, 0, 0)", design.navBg);
      check(`${label}: cards use the 18px card radius`, design.cardRadius === "18px", design.cardRadius);
      check(`${label}: selected controls take the pill radius`, design.tabRadius === "9999px", design.tabRadius);
      // Shadow is reserved for product imagery; UI elevation is surface + blur.
      check(`${label}: no card or button carries a shadow`, design.shadowed.length === 0, design.shadowed.join(", "));
      // One accent, non-negotiable per the spec.
      check(`${label}: every selected control uses the single accent`,
        design.accents.length === 1 && design.accents[0] === "rgb(0, 102, 204)", design.accents.join(" | "));
      check(`${label}: the sidebar chassis is gone`, design.sidebarGone);

      // Share mode exists so a busy period cannot masquerade as a bad one, which
      // only holds if every bar really does span the same total. Check the
      // geometry, not the arithmetic that produced it.
      await page.click('.view-tab[data-tab="overview"]');
      await page.waitForTimeout(400);
      const starGeo = await page.evaluate(() => {
        const byX = {};
        document.querySelectorAll('#starChart svg g rect').forEach(r => {
          const x = Math.round(+r.getAttribute('x'));
          byX[x] = (byX[x] || 0) + (+r.getAttribute('height'));
        });
        const h = Object.values(byX);
        return { bars: h.length, min: +Math.min(...h).toFixed(1), max: +Math.max(...h).toFixed(1) };
      });
      check(`${label}: every share bar spans the same total`,
        starGeo.bars > 0 && Math.abs(starGeo.max - starGeo.min) < 0.5, JSON.stringify(starGeo));

      // The SVG inherits RTL, where text-anchor "end" grows rightward — axis
      // labels written for LTR silently land on top of the bars.
      const spill = await page.evaluate(() => {
        const bad = [];
        document.querySelectorAll('#starChart svg text').forEach(t => {
          const bb = t.getBBox();
          if (+t.getAttribute('x') < 48 && bb.x + bb.width > 48) bad.push(t.textContent);
        });
        return bad;
      });
      check(`${label}: axis labels stay out of the plot`, spill.length === 0, spill.join(', '));

      // Volume belongs in its own strip with its own unit. Printing the count
      // over a percentage bar put two units in one mark and read as a bug.
      const units = await page.evaluate(() => {
        const svg = document.querySelector('#starChart svg');
        const bars = [...svg.querySelectorAll('g rect')];
        const topOfBars = Math.min(...bars.map(r => +r.getAttribute('y')));
        const overPlot = [...svg.querySelectorAll('text')].filter(t => {
          const bb = t.getBBox();
          return +t.getAttribute('x') > 48 && bb.y + bb.height <= topOfBars + 1;
        }).map(t => t.textContent);
        return { overPlot, strip: [...svg.querySelectorAll('text')].some(t => t.textContent === 'נפח') };
      });
      check(`${label}: no absolute count is printed over the percentage bars`,
        units.overPlot.length === 0, units.overPlot.join(', '));
      check(`${label}: share mode carries volume in its own strip`, units.strip);

      // Switching metric must not clear the other segmented control: an
      // unscoped '.seg button' reset used to wipe both.
      const segState = await page.evaluate(() => {
        document.querySelector('#starMetricSeg button[data-metric="count"]').click();
        return {
          metric: document.querySelectorAll('#starMetricSeg .active').length,
          bucket: document.querySelectorAll('#starBucketSeg .active').length,
        };
      });
      check(`${label}: chart controls keep independent state`,
        segState.metric === 1 && segState.bucket === 1, JSON.stringify(segState));

      // The staff tab once headlined "professionalism" as BOTH the standout
      // strength and the recurring failure, because both were picked by raw
      // count over one shared vocabulary. A manager reading that learns nothing.
      await page.click('.view-tab[data-tab="staff"]');
      await page.waitForTimeout(450);
      const staffTab = await page.evaluate(() => {
        const val = lbl => {
          const k = [...document.querySelectorAll('#staffKpis .kpi')]
            .find(x => x.querySelector('.k-label').textContent.includes(lbl));
          return k ? k.querySelector('.k-value').textContent.trim() : null;
        };
        return {
          strength: val('החוזקה'),
          failure: val('הכשל'),
          signalRows: document.querySelectorAll('#signalBars .sig-row').length,
          deptRows: document.querySelectorAll('#deptBars .cat-row').length,
        };
      });
      check(`${label}: staff strength and failure are different behaviours`,
        staffTab.strength && staffTab.failure && staffTab.strength !== staffTab.failure,
        JSON.stringify(staffTab));
      check(`${label}: staff behaviour + department breakdowns render`,
        staffTab.signalRows > 0 && staffTab.deptRows > 0, JSON.stringify(staffTab));

      // The quote panels are quotesToggle-down, not the default view. A class rule
      // ("display:flex") once outranked the [hidden] attribute, so all nine
      // rendered open: 4800px of quotes to scroll past, and a toggle that
      // looked broken. Assert collapse by measured height, not by attribute.
      const quotesToggle = await page.evaluate(() => {
        const open = () => [...document.querySelectorAll('#signalBars .sig-detail')].filter(d => d.offsetHeight > 0).length;
        const before = { open: open(), h: document.getElementById('signalBars').offsetHeight };
        document.querySelector('#signalBars .sig-row').click();
        return { before, after: { open: open(), h: document.getElementById('signalBars').offsetHeight } };
      });
      check(`${label}: behaviour quotes start collapsed`, quotesToggle.before.open === 0, JSON.stringify(quotesToggle.before));
      check(`${label}: clicking a behaviour opens its quotes`,
        quotesToggle.after.open === 1 && quotesToggle.after.h > quotesToggle.before.h, JSON.stringify(quotesToggle));

      // Every named employee is reachable by one click, not by scrolling the
      // whole board, and picking one narrows it to that person.
      const picker = await page.evaluate(() => {
        const chips = [...document.querySelectorAll('#staffPicker .chip')];
        const names = new Set([...document.querySelectorAll('#staffBoard tbody .item-name')].map(n => n.textContent.trim()));
        const before = document.querySelectorAll('#staffBoard tbody tr').length;
        chips[2].click();
        const after = document.querySelectorAll('#staffBoard tbody tr').length;
        document.querySelectorAll('#staffPicker .chip')[0].click();
        return { chips: chips.length, boardNames: names.size, before, after,
                 reset: document.querySelectorAll('#staffBoard tbody tr').length };
      });
      check(`${label}: a chip exists for every named employee`,
        picker.chips === picker.boardNames + 1, JSON.stringify(picker));
      check(`${label}: picking an employee narrows the board, and reset restores it`,
        picker.after === 1 && picker.reset === picker.before, JSON.stringify(picker));

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
      // Clicking a topic name reads that topic on its own WITHOUT leaving the
      // tab — the bottom button already covers "show me the list", and that
      // one costs you the side-by-side comparison.
      await page.click('.view-tab[data-tab="themes"]');
      await page.waitForTimeout(400);
      const focus = await page.evaluate(() => {
        const count = () => document.querySelectorAll('#themeGrid .theme-card').length;
        const before = count();
        document.querySelector('#themeGrid .theme-card .t-name').click();
        return { before, focused: document.querySelectorAll('.theme-card.focused').length,
                 shown: count(), quotes: document.querySelectorAll('.tf-quotes .quote').length,
                 tab: document.querySelector('.tab-panel.active').id,
                 back: !!document.querySelector('.theme-focus-bar .chip') };
      });
      check(`${label}: clicking a topic name focuses just that topic`,
        focus.focused === 1 && focus.shown < focus.before, JSON.stringify(focus));
      check(`${label}: focusing stays inside the themes tab`, focus.tab === 'tab-themes', focus.tab);
      check(`${label}: the focused topic shows more than one quote`, focus.quotes > 1, String(focus.quotes));
      const unfocus = await page.evaluate(() => {
        document.querySelector('.theme-focus-bar .chip').click();
        return { shown: document.querySelectorAll('#themeGrid .theme-card').length,
                 focused: document.querySelectorAll('.theme-card.focused').length };
      });
      check(`${label}: going back restores every topic`,
        unfocus.shown === focus.before && unfocus.focused === 0, JSON.stringify(unfocus));

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
