// scrape.mjs — skrapar 50/50-potterna och skriver data.json
// Prioriterar blinkande Total vinstpott (.animate-pulse), har klubbspecifika selektorer,
// filtrerar bort maxvinst per lott/avgifter, och inkluderar fail-safe för GitHub Actions.

import { chromium } from 'playwright';
import fs from 'fs/promises';

const CLUBS = [
  { name: 'Luleå HF',            url: 'https://clubs.clubmate.se/luleahockey/' },
  { name: 'Brynäs IF',           url: 'https://clubs.clubmate.se/brynas/' },
  { name: 'Djurgårdens IF',      url: 'https://clubs.clubmate.se/difhockey/' },
  { name: 'Färjestad BK',        url: 'https://clubs.clubmate.se/farjestadbk/' },
  { name: 'Frölunda HC',         url: 'https://clubs.clubmate.se/frolundahockey/' },
  { name: 'HV 71',               url: 'https://clubs.clubmate.se/hv71/' },
  { name: 'Leksands IF',         url: 'https://clubs.clubmate.se/leksandsif/' },
  { name: 'Linköping HC',        url: 'https://clubs.clubmate.se/lhc/' },
  { name: 'IF Malmö Redhawks',   url: 'https://clubs.clubmate.se/malmoredhawks/' },
  { name: 'Örebro HK',           url: 'https://clubs.clubmate.se/orebrohockey/' },
  { name: 'Rögle BK',            url: 'https://clubs.clubmate.se/roglebk/' },
  { name: 'Skellefteå AIK',      url: 'https://clubs.clubmate.se/skellefteaaik/' },
  { name: 'Timrå IK',            url: 'https://clubs.clubmate.se/timraik/' },
  { name: 'Växjö Lakers HC',     url: 'https://clubs.clubmate.se/vaxjolakers/' }
];

// Klubbspecifika selektorer (högst prioritet)
const SELECTORS = {
  // Luleå: pulserande h6 med "kr"
  'https://clubs.clubmate.se/luleahockey/': 'h6.font-bold.animate-pulse:has-text(" kr")',
  // Brynäs: pulserande total vinstpott
  'https://clubs.clubmate.se/brynas/': '.animate-pulse:has-text(" kr")',
  // Rögle: h6 med "kr"
  'https://clubs.clubmate.se/roglebk/': 'h6.font-bold:has-text(" kr")'
};

// Frasfilter: exkludera rader som handlar om avgifter, maxvinst per lott, merch etc.
const BAD_WORDS = [
  'presentkort','voucher','shop','shopen','butik','biljett','biljetter',
  'rabatt','t-shirt','hoodie','kampanj','erbjudande',
  '+','sms','köp','avgift','avg.','frakt',
  'maxvinst','max-vinst','max vinst','per lott'
];

const LABELS_PRIORITY = [
  /total\s+vinstpott/i,     // viktigast
  /aktuell\s+vinstsumma/i   // därefter
];

const MIN_VALID = 50;  // filtrera bort småbelopp som "+5 kr"
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const parseAmount = (txt) => {
  if (!txt) return null;
  const clean = txt.replace(/\u00A0|&nbsp;/g, ' ');
  const m = clean.match(/(\d[\d\s.,]*)\s*kr\b/i);
  if (!m) return null;
  const num = m[1].replace(/\s/g,'').replace(/\./g,'').replace(',','.');
  const n = parseFloat(num);
  return Number.isFinite(n) ? Math.round(n) : null;
};

const isBadText = (s) => s && BAD_WORDS.some(w => s.toLowerCase().includes(w));

// 0) Klubbspecifik hård selektor
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

// 1) Blinkande belopp (animate-pulse) — oftast Total vinstpott
async function getByPulse(page) {
  const candidates = await page.$$eval('.animate-pulse', els =>
    els
      .map(el => {
        const t = (el.textContent || '').replace(/\u00A0/g,' ').trim();
        const tag = (el.tagName || '').toLowerCase();
        return { t, tag };
      })
      .filter(x => /\skr\b/i.test(x.t))  // måste innehålla "kr"
  ).catch(()=>[]);

  // Prioritera rubriker (h1–h6) före andra element
  candidates.sort((a,b) => {
    const ah = /^h[1-6]$/.test(a.tag) ? 0 : 1;
    const bh = /^h[1-6]$/.test(b.tag) ? 0 : 1;
    return ah - bh;
  });

  for (const { t } of candidates) {
    if (isBadText(t)) continue;
    const n = parseAmount(t);
    if (n != null && n >= MIN_VALID) return { text: t, amount: n, strategy: 'pulse' };
  }
  return null;
}

// 2) Belopp nära etiketter (Total vinstpott -> Aktuell vinstsumma)
async function getByLabels(page) {
  const labelResult = await page.evaluate((labelRegexps) => {
    const txt = (el) => (el?.textContent || '').replace(/\u00A0/g,' ').trim();
    const nodes = Array.from(document.querySelectorAll('p,div,span,h5,h6'));
    for (const pattern of labelRegexps) {
      const re = new RegExp(pattern.pattern, pattern.flags);
      const label = nodes.find(el => re.test(txt(el)));
      if (!label) continue;
      const candidates = [];
      let n = label.nextElementSibling;
      for (let hops = 0; n && hops < 8; hops++, n = n.nextElementSibling) {
        const t = txt(n);
        if (/kr\b/i.test(t)) candidates.push(t);
        const kids = Array.from(n.querySelectorAll('*')).map(txt).filter(s => /\skr\b/i.test(s));
        candidates.push(...kids);
      }
      if (!candidates.length) {
        const parent = label.parentElement || document.body;
        const alt = Array.from(parent.querySelectorAll('*')).map(txt).filter(s => /\skr\b/i.test(s));
        if (alt.length) return { which: re.source, texts: alt };
      } else {
        return { which: re.source, texts: candidates };
      }
    }
    return null;
  }, LABELS_PRIORITY.map(re => ({ pattern: re.source, flags: re.flags || 'i' })));

  if (!labelResult?.texts?.length) return null;

  // välj största rimliga belopp nära labeln
  const good = [];
  for (const s of labelResult.texts) {
    if (isBadText(s)) continue;
    const n = parseAmount(s);
    if (n == null) continue;
    if (n < MIN_VALID) continue;
    good.push({ text: s, amount: n });
  }
  if (!good.length) return null;
  good.sort((a,b)=>b.amount - a.amount);
  const best = good[0];
  return { text: best.text, amount: best.amount, strategy: `near-label:${labelResult.which}` };
}

// 3) Generiska selektorer (rubriker med kr)
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
    if (isBadText(t)) continue;
    const n = parseAmount(t);
    if (n != null && n >= MIN_VALID) return { text: t, amount: n, strategy: `selector:${sel}` };
  }
  return null;
}

// 4) Maxbelopp i hela sidan (sista utväg)
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
  await sleep(1400);

  // 0) Hård selektor (klubbspecifik)
  const hard = await getByHardSelector(page, url);
  if (hard) return hard;

  // 1) Blinkande belopp
  const pulse = await getByPulse(page);
  if (pulse) return pulse;

  // 2) Etiketter i prioritet: Total vinstpott -> Aktuell vinstsumma
  const byLabels = await getByLabels(page);
  if (byLabels) return byLabels;

  // 3) Generiska selektorer
  const gen = await getByGenericSelectors(page);
  if (gen) return gen;

  // 4) Hela body: maxbelopp
  const body = await getBodyMax(page);
  if (body) return body;

  // 5) Sista retry (senladdade noder)
  await sleep(1200);
  const pulse2 = await getByPulse(page);
  if (pulse2) return pulse2;

  const byLabels2 = await getByLabels(page);
  if (byLabels2) return byLabels2;

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
      await sleep(900 + Math.floor(Math.random()*900)); // lite jitter mellan sidor

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

// ====== FAIL-SAFE: låt aldrig Actions falla helt ======
(async () => {
  try {
    await run();
  } catch (err) {
    console.error('Kritiskt fel i run():', err);
    try { await fs.writeFile('data.json', '[]', 'utf8'); } catch {}
    process.exit(0);
  }
})();
