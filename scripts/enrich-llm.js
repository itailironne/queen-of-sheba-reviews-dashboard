// Enriches each review with fields that require actually reading the text,
// which keyword matching cannot produce:
//   - themes                 (context-aware: "the sous-chef gave great service"
//                             is staff, not food)
//   - theme_sentiment        (per theme — today the dashboard applies the star
//                             rating to every theme, so a 1★ review praising the
//                             chef marks Food negative)
//   - staff_mentions         (name + role + sentiment)
//   - summary, severity, rating_text_mismatch
//
// Enrichment only ADDS an `llm` block; the scraped fields are never modified,
// and the keyword `themes` stay in place as a fallback, so deleting the block
// returns the dashboard to its pre-LLM behaviour.
//
// Runs once per review at ingest — never in the browser, so no API key is ever
// shipped to the client and the dashboard stays a static page.
//
// Usage:
//   node scripts/enrich-llm.js                # enrich everything not yet done
//   node scripts/enrich-llm.js --limit=5      # try a few first
//   node scripts/enrich-llm.js --force        # re-enrich everything
//   node scripts/enrich-llm.js --model=claude-haiku-4-5   # cheaper run

const fs = require('fs');
const path = require('path');
const Anthropic = require('@anthropic-ai/sdk');
const { z } = require('zod');
const { zodOutputFormat } = require('@anthropic-ai/sdk/helpers/zod');

const REVIEWS_PATH = path.join(__dirname, '..', 'data', 'reviews.json');
const THEMES = ['cleanliness', 'noise_ac', 'checkin_checkout', 'billing', 'pool', 'food',
  'staff_service', 'room_quality', 'kids_family', 'value_price', 'location'];

const Enrichment = z.object({
  themes: z.array(z.enum(THEMES))
    .describe('Topics the reviewer actually discusses. Judge what the sentence is about, not which words appear.'),
  theme_sentiment: z.array(z.object({
    theme: z.enum(THEMES),
    sentiment: z.enum(['positive', 'negative', 'mixed', 'neutral']),
  })).describe('Sentiment per theme AS EXPRESSED IN THE TEXT. A low-rated review can still praise one thing.'),
  staff_mentions: z.array(z.object({
    name: z.string().describe('Employee first name exactly as written. Empty array if none named.'),
    role: z.string().describe('Their role if stated, else "".'),
    sentiment: z.enum(['positive', 'negative']),
  })),
  summary: z.string().describe('One short Hebrew sentence a hotel manager could scan.'),
  severity: z.enum(['none', 'low', 'medium', 'high'])
    .describe('Operational risk: high = hygiene/safety/billing dispute or anything legally or reputationally serious.'),
  rating_text_mismatch: z.boolean()
    .describe('True when the star rating contradicts the text (e.g. 1 star on pure praise).'),
});

const SYSTEM = `אתה מנתח ביקורות אורחים עבור מלון בישראל.
לכל ביקורת החזר ניתוח מובנה.

כללים:
- שפוט לפי המשמעות, לא לפי הופעת מילים. "סגן השף נתן שירות מצוין" = צוות ושירות (ולא אוכל), כי המשפט על אדם.
- sentiment הוא לפי מה שנכתב בטקסט, לא לפי דירוג הכוכבים. ביקורת עם דירוג נמוך יכולה לשבח נושא מסוים.
- אזכור עובד נספר רק כששם פרטי מפורש מופיע בטקסט. אל תמציא שמות ואל תסיק מתפקיד בלבד.
- severity=high רק לסיכון תפעולי אמיתי: תברואה, בטיחות, פגיעה באורח, או סכסוך חיוב.
- summary במשפט עברי אחד, ענייני, בלי סופרלטיבים.`;

function loadReviews() { return JSON.parse(fs.readFileSync(REVIEWS_PATH, 'utf8')); }
function saveReviews(r) { fs.writeFileSync(REVIEWS_PATH, JSON.stringify(r, null, 2), 'utf8'); }

async function enrichOne(client, review, model) {
  const res = await client.messages.parse({
    model,
    max_tokens: 2000,
    system: [{ type: 'text', text: SYSTEM, cache_control: { type: 'ephemeral' } }],
    messages: [{
      role: 'user',
      content: `מקור: ${review.source}\nדירוג: ${review.rating}/5\nתאריך: ${review.posted_date_estimate || review.first_scraped_date}\n\nטקסט הביקורת:\n${review.text}`,
    }],
    output_config: { format: zodOutputFormat(Enrichment) },
  });
  if (!res.parsed_output) throw new Error('model returned unparseable output');
  return { ...res.parsed_output, model, enriched_at: new Date().toISOString().slice(0, 10) };
}

async function main() {
  const args = process.argv.slice(2);
  const limitArg = args.find(a => a.startsWith('--limit='));
  const modelArg = args.find(a => a.startsWith('--model='));
  const force = args.includes('--force');
  const model = modelArg ? modelArg.split('=')[1] : 'claude-opus-5';

  const reviews = loadReviews();
  let todo = reviews.filter(r => r.text && r.text.trim() && (force || !r.llm));
  if (limitArg) todo = todo.slice(0, parseInt(limitArg.split('=')[1]));

  console.log(`[enrich] model=${model} · ${todo.length} reviews to enrich (of ${reviews.length} total)`);
  if (!todo.length) return;

  const client = new Anthropic();
  let done = 0, failed = 0;
  const CONCURRENCY = 4;

  for (let i = 0; i < todo.length; i += CONCURRENCY) {
    const batch = todo.slice(i, i + CONCURRENCY);
    await Promise.all(batch.map(async (review) => {
      try {
        review.llm = await enrichOne(client, review, model);
        done++;
      } catch (e) {
        failed++;
        console.error(`  ✗ ${review.id} (${review.reviewer}): ${e.message}`);
      }
    }));
    // Save after every batch so an interrupted run never loses completed work.
    saveReviews(reviews);
    console.log(`  … ${done + failed}/${todo.length} (${failed} failed)`);
  }

  console.log(`[enrich] done: ${done} enriched, ${failed} failed`);
  if (failed) process.exitCode = 1;
}

main().catch(e => { console.error('[enrich] FATAL', e.message); process.exit(1); });
