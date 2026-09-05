// Converts the raw cards from scrape-booking-reviews.js into the same
// unified review schema used for Google (see lib/parse.js), dedup-merges
// them into data/reviews.json, and folds the site-wide Booking score/count
// into today's data/snapshots.json row alongside the Google/Tripadvisor
// figures already tracked there.
//
// Usage: node scripts/merge-booking.js [rawFile] [--date=YYYY-MM-DD]

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { tagThemes } = require('./lib/parse');

const ROOT = path.join(__dirname, '..');
const REVIEWS_PATH = path.join(ROOT, 'data', 'reviews.json');
const SNAPSHOTS_PATH = path.join(ROOT, 'data', 'snapshots.json');

function loadJSON(p, fallback) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return fallback; }
}
function todayISO() { return new Date().toISOString().slice(0, 10); }

function bookingReviewId(reviewer, date, title) {
  return 'bk_' + crypto.createHash('sha256').update(`${reviewer}|${date}|${title}`).digest('hex').slice(0, 16);
}

function toUnified(card, scrapeDateISO) {
  if (!card.date || card.score == null) return null;
  const parts = [];
  if (card.title) parts.push(card.title);
  if (card.positive) parts.push(`👍 מה שאהבו: ${card.positive}`);
  if (card.negative) parts.push(`👎 מה שלא אהבו: ${card.negative}`);
  const text = parts.join('\n').trim();
  const rating = Math.max(1, Math.min(5, Math.round(card.score / 2)));
  return {
    id: bookingReviewId(card.reviewer, card.date, card.title),
    reviewer: card.reviewer || 'אורח/ת',
    source: 'Booking',
    rating,
    trip_type: card.travelerType || null,
    text,
    sub_ratings: {},
    has_owner_response: !!card.hasOwnerReply,
    themes: tagThemes(text),
    relative_date_raw: null,
    posted_date_estimate: card.date, // exact date from Booking, not an estimate
    first_scraped_date: scrapeDateISO,
    booking_score_10: card.score,
    room_name: card.roomName || null,
  };
}

function mergeBooking(rawFile, dateISO, meta) {
  const raw = JSON.parse(fs.readFileSync(rawFile, 'utf8'));
  const cards = Array.isArray(raw) ? raw : raw.cards || [];
  const unified = cards.map(c => toUnified(c, dateISO)).filter(Boolean);

  const existingReviews = loadJSON(REVIEWS_PATH, []);
  const existingIds = new Set(existingReviews.map(r => r.id));
  let added = 0;
  for (const r of unified) {
    if (!existingIds.has(r.id)) { existingReviews.push(r); existingIds.add(r.id); added++; }
  }
  existingReviews.sort((a, b) => {
    const da = a.posted_date_estimate || a.first_scraped_date;
    const db = b.posted_date_estimate || b.first_scraped_date;
    return db.localeCompare(da);
  });
  fs.mkdirSync(path.dirname(REVIEWS_PATH), { recursive: true });
  fs.writeFileSync(REVIEWS_PATH, JSON.stringify(existingReviews, null, 2), 'utf8');

  if (meta && (meta.overallScore || meta.totalReviews || (meta.categories && Object.keys(meta.categories).length))) {
    const snapshots = loadJSON(SNAPSHOTS_PATH, []);
    let idx = snapshots.findIndex(s => s.date === dateISO);
    if (idx < 0) { snapshots.push({ date: dateISO }); idx = snapshots.length - 1; }
    snapshots[idx].booking_rating_10 = meta.overallScore;
    snapshots[idx].booking_reviews_total = meta.totalReviews;
    // Per-category averages (cleanliness, staff, facilities, comfort, location,
    // value, wifi). Property-wide, so they belong on the daily snapshot rather
    // than on individual reviews — Booking exposes no per-review breakdown.
    if (meta.categories && Object.keys(meta.categories).length) {
      snapshots[idx].booking_categories = meta.categories;
    }
    snapshots.sort((a, b) => a.date.localeCompare(b.date));
    fs.writeFileSync(SNAPSHOTS_PATH, JSON.stringify(snapshots, null, 2), 'utf8');
  }

  console.log(`[merge-booking] scraped=${unified.length} added=${added} totalInDataset=${existingReviews.length}`);
  return { added, totalInDataset: existingReviews.length };
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const rawFile = args.find(a => !a.startsWith('--')) || path.join(__dirname, '.last-booking-dump.json');
  const dateArg = args.find(a => a.startsWith('--date='));
  const dateISO = dateArg ? dateArg.split('=')[1] : todayISO();
  const rawContent = JSON.parse(fs.readFileSync(rawFile, 'utf8'));
  const meta = Array.isArray(rawContent) ? null : rawContent.meta;
  mergeBooking(rawFile, dateISO, meta);
}

module.exports = { mergeBooking, toUnified, bookingReviewId };
