// Parses the raw dump produced by scrape-reviews.js, merges newly-seen reviews
// into data/reviews.json (deduped by content hash — never duplicates on rerun),
// and appends/updates today's row in data/snapshots.json.
//
// Design note: Google only serves the ~30 most recent reviews per scrape
// (a pagination limit we could not get past — see HANDOFF.md). Running this
// DAILY and deduping on merge is what builds full history over time: each day
// only the genuinely-new reviews since yesterday get appended. Do not skip
// days if avoidable — a gap wider than the ~9-day window means reviews posted
// and since scrolled past get missed permanently.
//
// Usage: node scripts/merge-and-build.js [dumpFile] [--date=YYYY-MM-DD]

const fs = require('fs');
const path = require('path');
const { parseReviews, parseSnapshot } = require('./lib/parse');

const ROOT = path.join(__dirname, '..');
const REVIEWS_PATH = path.join(ROOT, 'data', 'reviews.json');
const SNAPSHOTS_PATH = path.join(ROOT, 'data', 'snapshots.json');

function loadJSON(p, fallback) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return fallback; }
}

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

function mergeAndBuild(dumpFile, dateISO) {
  const text = fs.readFileSync(dumpFile, 'utf8');
  const scraped = parseReviews(text, dateISO).filter(r => r.source === 'Google' && r.rating !== null);
  const snapshotToday = parseSnapshot(text, dateISO);

  const existingReviews = loadJSON(REVIEWS_PATH, []);
  const existingIds = new Set(existingReviews.map(r => r.id));

  let addedCount = 0;
  for (const r of scraped) {
    if (!existingIds.has(r.id)) {
      existingReviews.push(r);
      existingIds.add(r.id);
      addedCount++;
    }
  }
  // Sort newest-first by best-known date (posted_date_estimate, fallback first_scraped_date)
  existingReviews.sort((a, b) => {
    const da = a.posted_date_estimate || a.first_scraped_date;
    const db = b.posted_date_estimate || b.first_scraped_date;
    return db.localeCompare(da);
  });

  const snapshots = loadJSON(SNAPSHOTS_PATH, []);
  snapshotToday.new_reviews_scraped = addedCount;
  snapshotToday.total_reviews_in_dataset = existingReviews.length;
  const idxToday = snapshots.findIndex(s => s.date === dateISO);
  if (idxToday >= 0) snapshots[idxToday] = snapshotToday; else snapshots.push(snapshotToday);
  snapshots.sort((a, b) => a.date.localeCompare(b.date));

  fs.mkdirSync(path.dirname(REVIEWS_PATH), { recursive: true });
  fs.writeFileSync(REVIEWS_PATH, JSON.stringify(existingReviews, null, 2), 'utf8');
  fs.writeFileSync(SNAPSHOTS_PATH, JSON.stringify(snapshots, null, 2), 'utf8');

  console.log(`[merge] scraped=${scraped.length} added=${addedCount} totalInDataset=${existingReviews.length}`);
  console.log(`[merge] snapshot for ${dateISO}:`, JSON.stringify(snapshotToday));
  return { addedCount, totalInDataset: existingReviews.length, snapshotToday };
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const dumpFile = args.find(a => !a.startsWith('--')) || path.join(__dirname, '.last-dump.txt');
  const dateArg = args.find(a => a.startsWith('--date='));
  const dateISO = dateArg ? dateArg.split('=')[1] : todayISO();
  mergeAndBuild(dumpFile, dateISO);
}

module.exports = { mergeAndBuild };
