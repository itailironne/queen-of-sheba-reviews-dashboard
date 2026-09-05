// Second, focused enrichment pass: only reviews that talk about staff.
//
// The first pass answers "was the guest happy with the staff". A manager needs
// the next question answered: WHAT did the staff do. So this extracts the
// behaviours behind the sentiment, from a fixed vocabulary, plus the department
// each mention belongs to and the sentence that proves it.
//
// Fixed vocabulary on purpose: free-text labels would splinter into dozens of
// near-synonyms and could not be counted or trended.
//
// Usage:
//   node scripts/enrich-service.js               # all staff-related reviews
//   node scripts/enrich-service.js --limit=5
//   node scripts/enrich-service.js --force

const fs = require('fs');
const path = require('path');
const Anthropic = require('@anthropic-ai/sdk');
const { z } = require('zod');
const { zodOutputFormat } = require('@anthropic-ai/sdk/helpers/zod');

const REVIEWS_PATH = path.join(__dirname, '..', 'data', 'reviews.json');

const SIGNALS = [
  'warmth',            // יחס אישי, חום, חיוך
  'responsiveness',    // מהירות תגובה לבקשה
  'problem_solving',   // פתרו בעיה בפועל
  'professionalism',   // מקצועיות, ידע, יעילות
  'proactivity',       // יוזמה, אכפתיות בלי שביקשו
  'dismissiveness',    // זלזול, אדישות, "לא עניין אותם"
  'unresponsive',      // הבטיחו לחזור ולא חזרו, אין מענה
  'rudeness',          // גסות רוח, הרמת קול
  'understaffed',      // עומס, אין מספיק אנשים, תורים
  'language_barrier',
];
const DEPARTMENTS = ['reception', 'dining', 'housekeeping', 'pool_spa', 'management', 'maintenance', 'other'];

const ServiceAnalysis = z.object({
  signals: z.array(z.object({
    signal: z.enum(SIGNALS),
    sentiment: z.enum(['positive', 'negative']),
    evidence: z.string().describe('The exact phrase from the review, quoted verbatim, that shows this. Keep it short.'),
  })).describe('Only behaviours the text actually describes. Empty array if the review says nothing about how staff behaved.'),
  departments: z.array(z.enum(DEPARTMENTS)).describe('Which departments the staff comments concern.'),
  staff_departments: z.array(z.object({
    name: z.string().describe('Employee name exactly as written in the review.'),
    department: z.enum(DEPARTMENTS),
  })).describe('Department for each employee named in this review. Empty if none named.'),
});

const SYSTEM = `אתה מנתח את **התנהגות הצוות** בביקורות אורחים של מלון.

המטרה: שמנהל יבין מה הצוות עשה בפועל — לא רק אם האורח היה מרוצה.

כללים:
- החזר רק התנהגויות שהטקסט באמת מתאר. אם האורח כתב "שירות מצוין" בלי לפרט — זה professionalism חיובי, ולא יותר.
- evidence חייב להיות ציטוט מילולי מהטקסט, קצר. אל תנסח מחדש.
- אותה ביקורת יכולה להכיל גם התנהגות חיובית וגם שלילית — החזר את שתיהן.
- unresponsive = הבטיחו לחזור/לטפל ולא קרה. dismissiveness = היו שם אבל לא היה אכפת.
- department לפי ההקשר: קבלה=reception, חדר אוכל/מלצרים/שף=dining, ניקיון חדרים=housekeeping,
  בריכה/ספא=pool_spa, הנהלה/מנהל=management, אחזקה/תיקונים=maintenance.`;

function loadReviews() { return JSON.parse(fs.readFileSync(REVIEWS_PATH, 'utf8')); }
function saveReviews(r) { fs.writeFileSync(REVIEWS_PATH, JSON.stringify(r, null, 2), 'utf8'); }

async function analyseOne(client, review, model) {
  const res = await client.messages.parse({
    model,
    max_tokens: 2000,
    system: [{ type: 'text', text: SYSTEM, cache_control: { type: 'ephemeral' } }],
    messages: [{ role: 'user', content: `דירוג: ${review.rating}/5\n\n${review.text}` }],
    output_config: { format: zodOutputFormat(ServiceAnalysis) },
  });
  if (!res.parsed_output) throw new Error('unparseable output');
  return { ...res.parsed_output, model, analysed_at: new Date().toISOString().slice(0, 10) };
}

async function main() {
  const args = process.argv.slice(2);
  const limitArg = args.find(a => a.startsWith('--limit='));
  const modelArg = args.find(a => a.startsWith('--model='));
  const force = args.includes('--force');
  const model = modelArg ? modelArg.split('=')[1] : 'claude-opus-5';

  const reviews = loadReviews();
  // Only reviews the first pass judged to be about staff, or that named someone.
  const relevant = r => r.text && r.llm &&
    ((r.llm.themes || []).includes('staff_service') || (r.llm.staff_mentions || []).length);
  let todo = reviews.filter(r => relevant(r) && (force || !r.service));
  if (limitArg) todo = todo.slice(0, parseInt(limitArg.split('=')[1]));

  console.log(`[service] model=${model} · ${todo.length} staff-related reviews to analyse`);
  if (!todo.length) return;

  const client = new Anthropic();
  let done = 0, failed = 0;
  const CONCURRENCY = 4;
  for (let i = 0; i < todo.length; i += CONCURRENCY) {
    await Promise.all(todo.slice(i, i + CONCURRENCY).map(async (review) => {
      try { review.service = await analyseOne(client, review, model); done++; }
      catch (e) { failed++; console.error(`  ✗ ${review.id}: ${e.message}`); }
    }));
    saveReviews(reviews);
    console.log(`  … ${done + failed}/${todo.length} (${failed} failed)`);
  }
  console.log(`[service] done: ${done} analysed, ${failed} failed`);
  if (failed) process.exitCode = 1;
}

main().catch(e => { console.error('[service] FATAL', e.message); process.exit(1); });
