// scrape.mjs — skrapar 50/50-potterna och skriver data.json (Actions-ready, robust mot småbelopp)
import { chromium } from 'playwright';
import fs from 'fs/promises';

const CLUBS = [
  { name: 'Luleå HF', url: 'https://clubs.clubmate.se/luleahockey/' },
  { name: 'Brynäs IF', url: 'https://clubs.clubmate.se/brynas/' },
  { name: 'Djurgårdens IF', url: 'https://clubs.clubmate.se/difhockey/' },
  { name: 'Färjestad BK', url: 'https://clubs.clubmate.se/farjestadbk/' },
  { name: 'Frölunda HC', url: 'https://clubs.clubmate.se/frolundahockey/' },
  { name: 'HV 71', url: 'https://clubs.clubmate.se/hv71/' },
  { name: 'Leksands IF', url: 'https://clubs.clubmate.se/leksandsif/' },
  { name: 'Linköping HC', url: 'https://clubs.clubmate.se/lhc/' },
  { name: 'IF Malmö Redhawks', url: 'https://clubs.clubmate.se/malmoredhawks/' },
  { name: 'Örebro HK', url: 'https://clubs.clubmate.se/orebrohockey/' },
  { name: 'Rögle BK', url: 'https://clubs.clubmate.se/roglebk/' },
  { name: 'Skellefteå AIK', url: 'https://clubs.clubmate.se/skellefteaaik/' },
  { name: 'Timrå IK', url: 'https://clubs.clubmate.se/timraik/' },
  { name: 'Växjö Lakers HC', url: 'https://clubs.clubmate.se/vaxjolakers/' }
];

// Hårda selektorer för kända sidor (prioriteras först)
// För Luleå pekar vi direkt på pulserande pottraden.
const SELECTORS = {
  'https://clubs.clubmate.se/luleahockey/': 'h6.font-bold.animate-pulse:has-text(" kr")',
  'https://clubs.clubmate.se/roglebk/': 'h6.font-bold:has-text(" kr")'
};

const BAD_WORDS = [
  'presentkort','voucher','shop','shopen','butik','biljett','biljetter',
  'rabatt','t-shirt','hoodie','kampanj','erbjudande','+','sms','köp','avgift'
];

const MIN_VALID = 50; // välj aldrig under detta
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const parseAmount = (txt) => {
  if (!txt) return null;
  const clean = txt.replace(/\u00A0/g, ' ');
  const m = clean.match(/(\d[\d\s.,]*)\s*kr\b/i);
  if (!m) return null;
  const num = m[1].replace(/\s/g,'').replace(/\./g,'').replace(',','.');
  const n = parseFloat(num);
  return Number.isFinite(n) ? Math.round(n) : null;
};

const isBadText = (s) => s && BAD_WORDS.some(w => s.toLowerCase().includes(w));

async function getByHardSelector(page, url) {
  const sel = SELECTORS[url];
  if (!sel) return null;
  try {
    await page.waitForSelector(sel, { timeout: 9000 });
    const t = (await page.textContent(sel) || '').replace(/\u00A0/g,' ').trim();
    const n = parseAmount(t);
    if (n != null && n >= MIN_VALID) return { text: t, amount: n, strategy: `hard:${sel}` };
  } catch {}
  return null;
}

// DOM-ankare: leta efter "Aktuell vinstsumma" och plocka belopp i närheten (DOM-ordning)
async function getByLabelDOM(page) {
  return await page.evaluate(() => {
    const txt = (el) => (el?.textContent || '').replace(/\u00A0/g, ' ').trim();
    const nodes = Array.from(document.querySelectorAll('p,div,span,h5,h6'));
    const label = nodes.find(el => /aktuell\s+vinstsumma/i.test(txt(el)));
    if (!label) return null;
    const candidates = [];
    let n = label.nextElementSibling;
    for (let hops = 0; n && hops < 6; hops++, n = n.nextElementSibling) {
      const t = txt(n);
      if (/kr\b/i.test(t)) candidates.push(t);
      const kids = Array.from(n.querySelectorAll('*')).map(txt).filter(s => /\skr\b/i.test(s));
      candidates.push(...kids);
    }
    if (!candidates.length) {
      const parent = label.parentElement || document.body;
      const alt = Array.from(parent.querySelectorAll('*')).map(txt).filter(s => /\skr\b/i.test(s));
      candidates.push(...alt);
    }
    return { texts: candidates };
  });
}

// Välj bästa kandidat, men ALDRIG under MIN_VALID
function chooseBestAmount(texts, strategyTag) {
  const good = [];
  for (const s of (texts || [])) {
    if (isBadText(s)) continue;
    const n = parseAmount(s);
    if (n == null) continue;
    if (n < MIN_VALID) continue; // aldrig småbelopp
    good.push({ text: s, amount: n });
  }
  if (!good.length) return null;
  good.sort((a,b) => b.amount - a.amount);
  const best = good[0];
  return { text: best.text, amount: best.amount, strategy: strategyTag };
}

async function getByGenericSelectors(page) {
  const sels = [
    'h6.font-bold:has-text(" kr")',
    '.font-bold.text-2xl:has-text(" kr")',
    'h6:has-text(" kr")',
    '[class*="text-2xl"]:has-text(" kr")'
  ];
  for (const sel of sels) {
    const el = await page.$(sel);
    if (!el) continue;
    const t = (await el.textContent() || '').replace(/\u00A0/g,' ').trim();
    const n = parseAmount(t);
    if (n != null && !isBadText(t) && n >= MIN_VALID) return { text: t, amount: n, strategy: `selector:${sel}` };
  }
  return null;
}

async function getBodyMax(page) {
  const body = await page.evaluate(() => document.body.innerText.replace(/\u00A0/g,' '));
  const matches = [...body.matchAll(/(\d[\d\s.,]*)\s*kr\b/gi)].map(m => m[0]);
  if (!matches.length) return null;
  let best = null, bestAmt = -Infinity;
  for (const s of matches) {
    if (isBadText(s)) continue;
    const n = (() => {
      const mm = s.match(/(\d[\d\s.,]*)\s*kr\b/i);
      if (!mm) return null;
      const num = mm[1].replace(/\s/g,'').replace(/\./g,'').replace(',','.');
      const v = parseFloat(num);
      return Number.isFinite(v) ? v : null;
    })();
    if (n != null && n >= MIN_VALID && n > bestAmt) { bestAmt = n; best = s; }
  }
  if (bestAmt === -Infinity) return null;
  return { text: best, amount: Math.round(bestAmt), strategy: 'body-max' };
}

async function extractPot(page, url) {
  await page.waitForLoadState('domcontentloaded');
  await sleep(1500);

  // 0) Hård selektor först
  const hard = await getByHardSelector(page, url);
  if (hard) return hard;

  // 1) Vänta tills sidan sannolikt renderat “kr” eller labeln
  try {
    await page.waitForFunction(() => {
      const els = Array.from(document.querySelectorAll('p,div,span,h5,h6'));
      const hasLabel = els.some(el => /aktuell\s+vinstsumma/i.test((el.textContent||'')));
      const hasKr = /kr\b/i.test((document.body.innerText||''));
      return hasLabel || hasKr;
    }, { timeout: 9000 });
  } catch {}

  // 2) Nära labeln
  const near = await getByLabelDOM(page);
  if (near?.texts?.length) {
    const chosen = chooseBestAmount(near.texts, 'near-label-follow');
    if (chosen) return chosen;
  }

  // 3) Generiska selektorer
  const gen = await getByGenericSelectors(page);
  if (gen) return gen;

  // 4) Hela body, välj största rimliga belopp
  const body = await getBodyMax(page);
  if (body) return body;

  // 5) Sista retry
  await sleep(1200);
  const near2 = await getByLabelDOM(page);
  if (near2?.texts?.length) {
    const chosen = chooseBestAmount(near2.texts, 'retry-near-label');
    if (chosen) return chosen;
  }
  return { text: null, amount: null, strategy: 'not-found' };
}

async function run() {
  const browser = await chromium.launch({ args: ['--no-sandbox'] });
  const context = await browser.newContext({
    viewport: { width: 1366, height: 900 },
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36'
  });
  const page = await context.newPage();

  const out = [];
  for (const c of CLUBS) {
    try {
      await page.goto(c.url, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await sleep(900 + Math.floor(Math.random()*900)); // lite jitter

      const res = await extractPot(page, c.url);
      out.push({
        club: c.name,
        amount: res.amount ?? null,
        currency: 'SEK',
        url: c.url,
        fetched_at: new Date().toISOString(),
        debug: { strategy: res.strategy, raw: res.text }
      });

      console.log(`${c.name}: ${res.amount != null ? res.amount + ' kr' : '—'}  [${res.strategy}${res.text ? ' | ' + res.text : ''}]`);
    } catch (e) {
      out.push({
        club: c.name, amount: null, currency: 'SEK', url: c.url,
        error: e.message, fetched_at: new Date().toISOString()
      });
      console.warn(`Fel för ${c.name}: ${e.message}`);
    }
  }

  await fs.writeFile('data.json', JSON.stringify(out, null, 2), 'utf8');
  await browser.close();
  console.log('\nKlart. Skrev data.json med', out.length, 'rader.');
}

// ====== FAIL-SAFE ======
(async () => {
  try {
    await run();
  } catch (err) {
    console.error('Kritiskt fel i run():', err);
    try { await fs.writeFile('data.json', '[]', 'utf8'); } catch {}
    process.exit(0);
  }
})();

