'use strict';
const crypto = require('crypto');

const TRIP_TYPE_RE = /^(חופשה|עסקים|חברים|נסיעה (משפחתית|זוגית)|חופשה ❘ נסיעה (משפחתית|זוגית))$/;
const METADATA_PREFIX_RE = /^(המאפיינים הבולטים של המלון|חדרים[^\d]|אוכל ושתייה[^\d]|פעילויות באזור|בטיחות|מסלולי הליכה|פרטים שכדאי לדעת)/;

// The sticky page footer (hotel name / nightly price / date range / price CTA)
// and the lazy-load spinner label sit after the LAST review card with no
// following anchor to bound it, so without this they leak into that review's
// text. Bug found 2026-09-05 via a quote reading "...מיקום נח מאוד, שרות מדהים,
// ואוכל טעים, תודה. מלון מלכת שבא ‏1,106 ‏₪ • 5–6 בספט׳ הצגת מחירים".
const FOOTER_LINE_RE = /^(מלון מלכת שבא|הצגת מחירים|הדף נטען\.?|•|‏?[\d,]+ ‏?₪|\d{1,2}[–-]\d{1,2} ב.+׳?)$/;

const THEME_KEYWORDS = {
  cleanliness: ['נקי', 'מלוכלך', 'אבק', 'שיער', 'עובש', 'פטרת', 'מזוהם', 'לכלוך', 'ניקיון', 'מטונף'],
  noise_ac: ['רעש', 'מזגן', 'רועש', 'מזגנים', 'שקט'],
  checkin_checkout: ["צ'ק אין", "צ'ק-אין", "צ'ק אאוט", "צ'ק-אאוט", 'המתנה', 'ממתינים', 'לחכות לחדר'],
  billing: ['חייבו', 'חיובים', 'לחייב', 'כרטיס אשראי', 'זיכוי', 'פיקדון', 'תשלום כפול', 'חשבון'],
  pool: ['בריכה', 'בריכת', 'מחוממת', "ג'קוזי"],
  food: ['אוכל', 'ארוחת בוקר', 'ארוחת ערב', 'מסעדה', 'שף', 'קפה', 'מזון'],
  staff_service: ['שירות', 'צוות', 'אדיב', 'מקצועי', 'עובד', 'עובדת', 'מנהל'],
  room_quality: ['שטיח', 'מיטה', 'מקלחת', 'ריהוט', 'מיושן', 'ישן', 'חלון'],
  kids_family: ['ילדים', 'תינוקות', "ג'ימבורי", 'משפחתית', 'ילד', 'ילדה'],
  value_price: ['יקר', 'מחיר', 'תמורה', 'שקל', '₪'],
  location: ['מיקום', 'טיילת', 'קרוב לים', 'מרכז העיר'],
};

// Whole words that contain a keyword but mean something unrelated. Found by
// auditing every keyword against the real corpus (2026-09-05):
//   נקי  inside ענקיות/ענקית  ("giant", not "clean")
//   יקר  inside בעיקר/העיקרית ("mainly", not "expensive")
//   חיוב inside החיובי/לחיובי ("positive", not "a charge")
//   עלות inside להעלות        ("to upload", not "cost")  — keyword dropped
const THEME_EXCLUDE = [
  /^ה?ענקי/, /^ענק/, /עיקר/, /^ה?חיובי(ת|ים)?$/, /להעלות/,
];

// Hebrew glues prefixes onto words (ו/ב/ל/מ/ש/כ/ה), so a plain substring test
// is right for "בבריכה" but wrong for "ענקיות" — the latter buries "נקי" behind
// a letter that is NOT a prefix. Allow up to two prefix letters and nothing
// else, then reject known meaning-changing host words.
const HEB_PREFIX = 'ובלמשכה'; // ו ב ל מ ש כ ה
const HEB_LETTER = 'א-ת';

function keywordRegex(word) {
  const esc = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?:^|[^${HEB_LETTER}])[${HEB_PREFIX}]{0,2}(${esc})`, 'g');
}

function hostWordAt(text, index) {
  let s = index, e = index;
  const isHeb = c => c && new RegExp(`[${HEB_LETTER}]`).test(c);
  while (s > 0 && isHeb(text[s - 1])) s--;
  while (e < text.length && isHeb(text[e])) e++;
  return text.slice(s, e);
}

// Returns every real match of a theme's keywords: [{keyword, index, length}].
// Shared by the tagger and by the dashboard's highlighting so the text a reader
// sees highlighted is exactly what classified the review.
function findThemeMatches(text, theme) {
  const words = THEME_KEYWORDS[theme] || [];
  const out = [];
  for (const w of words) {
    const re = keywordRegex(w);
    let m;
    while ((m = re.exec(text)) !== null) {
      const idx = m.index + m[0].length - m[1].length;
      const host = hostWordAt(text, idx);
      if (THEME_EXCLUDE.some(rx => rx.test(host))) continue;
      out.push({ keyword: m[1], index: idx, length: m[1].length, host });
    }
  }
  return out.sort((a, b) => a.index - b.index);
}

function tagThemes(text) {
  if (!text) return [];
  return Object.keys(THEME_KEYWORDS).filter(theme => findThemeMatches(text, theme).length > 0);
}

function parseRelativeDays(rel) {
  rel = rel.trim();
  if (/שעות|שעה/.test(rel)) return 0;
  if (rel === 'יום') return 1;
  if (rel === 'יומיים') return 2;
  let m = rel.match(/^(\d+)\s*ימים$/);
  if (m) return parseInt(m[1]);
  if (rel === 'שבוע') return 7;
  if (rel === 'שבועיים') return 14;
  m = rel.match(/^(\d+)\s*שבועות$/);
  if (m) return parseInt(m[1]) * 7;
  if (rel === 'חודש') return 30;
  if (rel === 'חודשיים') return 60;
  m = rel.match(/^(\d+)\s*חודשים$/);
  if (m) return parseInt(m[1]) * 30;
  if (rel === 'שנה') return 365;
  m = rel.match(/^(\d+)\s*שנים$/);
  if (m) return parseInt(m[1]) * 365;
  return null;
}

function reviewId(reviewer, text) {
  return crypto.createHash('sha256').update(reviewer + '|' + text.slice(0, 150)).digest('hex').slice(0, 16);
}

function parseReviews(text, scrapeDateISO) {
  const lines = text.split('\n');
  const DATE_RE = /^(?:תאריך העריכה: )?לפני (.+?) באתר\s+(Google|Tripadvisor)$/;
  const anchors = [];
  for (let i = 1; i < lines.length; i++) {
    const m = lines[i].match(DATE_RE);
    if (m) anchors.push({ lineIdx: i, name: lines[i - 1].trim(), rel: m[1], source: m[2] });
  }

  const reviews = [];
  for (let a = 0; a < anchors.length; a++) {
    const start = anchors[a].lineIdx + 1;
    const end = a + 1 < anchors.length ? anchors[a + 1].lineIdx - 1 : lines.length;
    const block = lines.slice(start, end);

    let rating = null;
    let tripType = null;
    const bodyLines = [];
    let hasOwnerResponse = false;
    let inResponse = false;
    let idx = 0;

    while (idx < block.length && block[idx].trim() === '') idx++;
    const ratingMatch = block[idx] && block[idx].trim().match(/^(\d)\/5$/);
    if (ratingMatch) { rating = parseInt(ratingMatch[1]); idx++; }

    if (block[idx] && TRIP_TYPE_RE.test(block[idx].trim())) {
      tripType = block[idx].trim();
      idx++;
    }

    for (; idx < block.length; idx++) {
      const trimmed = block[idx].trim();
      if (trimmed === 'תגובה מהבעלים') { hasOwnerResponse = true; inResponse = true; continue; }
      if (inResponse) continue;
      if (trimmed === '') continue;
      if (METADATA_PREFIX_RE.test(trimmed)) continue;
      if (FOOTER_LINE_RE.test(trimmed)) break; // page footer — nothing after it belongs to the review
      if (/^(חדרים|שירות|מיקום)(\d\.\d)+/.test(trimmed.replace(/\s/g, ''))) continue;
      bodyLines.push(trimmed);
    }

    const subRatings = {};
    const compact = block.join('').replace(/\s/g, '');
    const srRe = /(חדרים|שירות|מיקום)(\d\.\d)/g;
    let srMatch;
    while ((srMatch = srRe.exec(compact)) !== null) {
      const key = { 'חדרים': 'rooms', 'שירות': 'service', 'מיקום': 'location' }[srMatch[1]];
      subRatings[key] = parseFloat(srMatch[2]);
    }

    const daysAgo = parseRelativeDays(anchors[a].rel);
    let postedDate = null;
    if (daysAgo !== null) {
      const d = new Date(scrapeDateISO + 'T12:00:00Z');
      d.setUTCDate(d.getUTCDate() - daysAgo);
      postedDate = d.toISOString().slice(0, 10);
    }

    const bodyText = bodyLines.join('\n').trim();
    reviews.push({
      id: reviewId(anchors[a].name, bodyText || anchors[a].name),
      reviewer: anchors[a].name,
      source: anchors[a].source,
      rating,
      trip_type: tripType,
      text: bodyText,
      sub_ratings: subRatings,
      has_owner_response: hasOwnerResponse,
      themes: tagThemes(bodyText),
      relative_date_raw: anchors[a].rel,
      posted_date_estimate: postedDate,
      first_scraped_date: scrapeDateISO,
    });
  }
  return reviews;
}

function parseSnapshot(text, dateISO) {
  const snap = { date: dateISO };
  let m = text.match(/סיכום הביקורות ב-Google\n(\d\.\d)\n([\d,]+) ביקורות/);
  if (m) {
    snap.overall_rating = parseFloat(m[1]);
    snap.total_reviews_google = parseInt(m[2].replace(/,/g, ''));
  }
  m = text.match(/Tripadvisor\n(\d\.\d)\/5 · ([\d,]+) ביקורות/);
  if (m) {
    snap.tripadvisor_rating = parseFloat(m[1]);
    snap.tripadvisor_reviews = parseInt(m[2].replace(/,/g, ''));
  }
  const topicRe = /^([א-ת][א-ת \-]*|Wi-Fi) \((\d+)\)$/gm;
  const topics = {};
  let tm;
  while ((tm = topicRe.exec(text)) !== null) {
    if (tm[1] === 'ועוד') continue;
    topics[tm[1].trim()] = parseInt(tm[2]);
  }
  snap.topic_mention_counts = topics;
  return snap;
}

module.exports = { parseReviews, parseRelativeDays, parseSnapshot, tagThemes, reviewId, THEME_KEYWORDS, THEME_EXCLUDE, findThemeMatches };
