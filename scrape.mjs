// scrape.mjs
// Hämtar 50/50-potterna och skriver till data.json
// Kör: node scrape.mjs

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
  { name: 'Rögle BK', url: 'https://clubs.clubmate.se/roglebk/' }, // låses hårt
  { name: 'Skellefteå AIK', url: 'https://clubs.clubmate.se/skellefteaaik/' },
  { name: 'Timrå IK', url: 'https://clubs.clubmate.se/timraik/' },
  { name: 'Växjö Lakers HC', url: 'https://clubs.clubmate.se/vaxjolakers/' },
];

// Hårda selektorer för kända specialfall
const SELECTORS = {
  'https://clubs.clubmate.se/roglebk/': 'h6.font-bold:has-text(" kr")',
};

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function parseAmount(txt) {
  if (!txt) return null;
  const clean = txt.replace(/\u00A0/g, ' ');
  const m = clean.match(/(\d[\d\s.,]*)\s*kr\b/i); // ta allt mellan första siffran och "kr"
  if (!m) return null;
  const num = m[1].replace(/\s/g, '').replace(/\./g, '').replace(',', '.');
  const n = parseFloat(num);
  return Number.isFinite(n) ? Math.round(n) : null;
}

function isBadText(s) {
  if (!s) return true;
  const low = s.toLowerCase();
  // uteslut typiska icke-pottrader
  if (low.includes('+') || low.includes('sms') || low.includes('köp') || low.includes('avgift')) return true;
  if (low.includes('presentkort') || low.includes('biljett') || low.includes('biljetter')) return true;
  if (low.includes('shop') || low.includes('shopen') || low.includes('butik') || low.includes('t-shirt') || low.includes('hoodie')) return true;
  return false;
}

async function getByHardSelector(page, url) {
  const sel = SELECTORS[url];
  if (!sel) return null;
  try {
    await page.waitForSelector(sel, { timeout: 8000 });
    const t = (await page.textContent(sel) || '').replace(/\u00A0/g, ' ').trim();
    const n = parseAmount(t);
    if (n != null) return { text: t, amount: n, strategy: `hard:${sel}` };
  } catch {}
  return null;
}

// 1) DOM-ankare: textnoden "Aktuell vinstsumma" → ta första efterföljande H6/BOLD som innehåller "kr"
//    (ignorera 0 kr och småbelopp < 50 kr)
async function getByLabelDOM(page) {
  return await page.evaluate(() => {
    const getTxt = el => (el?.textContent || '').replace(/\u00A0/g, ' ').trim();
    const findLabel = () => {
      const nodes = Array.from(document.querySelectorAll('p,div,span,h5,h6'));
      return nodes.find(el => /aktuell\s+vinstsumma/i.test(getTxt(el)));
    };
    const label = findLabel();
    if (!label) return null;

    // Gå framåt i DOM-ordning några syskon och deras barn
    const candidates = [];
    let n = label.nextElementSibling;
    for (let hops = 0; n && hops < 6; hops++, n = n.nextElementSibling) {
      const t = getTxt(n);
      if (/kr\b/i.test(t)) candidates.push(t);
      // även barn
      const kids = Array.from(n.querySelectorAll('*')).map(getTxt).filter(s => /\skr\b/i.test(s));
      candidates.push(...kids);
    }

    if (!candidates.length) {
      // sista chans i labelns förälder
      const parent = label.parentElement || document.body;
      const alt = Array.from(parent.querySelectorAll('*')).map(getTxt).filter(s => /\skr\b/i.test(s));
      candidates.push(...alt);
    }

    // returnera alla råkandidater (text), låt Node-delen filtrera/poängsätta
    return { texts: candidates };
  });
}

// 2) Generella selektorer (headlines/bold som innehåller "kr")
async function getByGenericSelectors(page) {
  const sels = [
    'h6.font-bold:has-text(" kr")',
    '.font-bold.text-2xl:has-text(" kr")',
    'h6:has-text(" kr")',
    '[class*="text-2xl"]:has-text(" kr")',
  ];
  for (const sel of sels) {
    const el = await page.$(sel);
    if (!el) continue;
    const t = (await el.textContent() || '').replace(/\u00A0/g, ' ').trim();
    if (/\skr\b/i.test(t)) return { text: t, amount: null, strategy: `generic:${sel}` };
  }
  return null;
}

// 3) Sista utväg: plocka alla "... kr" i body och välj största belopp
async function getBodyMax(page) {
  const body = await page.evaluate(() => document.body.innerText.replace(/\u00A0/g, ' '));
  const matches = [...body.matchAll(/(\d[\d\s.,]*)\s*kr\b/gi)].map(m => m[0]);
  if (!matches.length) return null;
  let best = null, bestAmt = -Infinity;
  for (const s of matches) {
    const n = (() => {
      const mm = s.match(/(\d[\d\s.,]*)\s*kr\b/i);
      if (!mm) return null;
      const num = mm[1].replace(/\s/g,'').replace(/\./g,'').replace(',','.');
      const v = parseFloat(num);
      return Number.isFinite(v) ? v : null;
    })();
    if (n != null && n > bestAmt) { bestAmt = n; best = s; }
  }
  if (bestAmt === -Infinity) return null;
  return { text: best, amount: Math.round(bestAmt), strategy: 'body-max' };
}

function chooseBestAmountFromTexts(texts, hintStrategy) {
  const candidates = [];
  for (const s of (texts || [])) {
    const n = parseAmount(s);
    if (n == null) continue;
    // bort med uppenbart irrelevanta rader
    if (isBadText(s)) continue;
    if (n < 50) continue;       // filtrera småbelopp (t.ex. "+5 kr")
    candidates.push({ text: s, amount: n });
  }
  if (!candidates.length) {
    // om inget återstår, tillåt 0–49 kr men fortfarande utan badText
    for (const s of (texts || [])) {
      const n = parseAmount(s);
      if (n == null) continue;
      if (isBadText(s)) continue;
      candidates.push({ text: s, amount: n });
    }
  }
  if (!candidates.length) return null;
  // välj största beloppet (potten är normalt störst)
  candidates.sort((a,b) => b.amount - a.amount);
  const best = candidates[0];
  return { text: best.text, amount: best.amount, strategy: hintStrategy || 'label-follow' };
}

async function extractPot(page, url) {
  await page.waitForLoadState('domcontentloaded');
  // ge deras JS lite tid att hämta in siffrorna
  await sleep(1800);

  // 0) Hård selektor om definierad
  const hard = await getByHardSelector(page, url);
  if (hard) return hard;

  // 1) DOM-nära labeln
  try {
    await page.waitForFunction(() =>
      /kr\b/i.test(document.body.innerText) ||
      Array.from(document.querySelectorAll('p,div,span,h5,h6')).some(el =>
        /aktuell\s+vinstsumma/i.test((el.textContent||''))), { timeout: 8000 });
  } catch {}

  const near = await getByLabelDOM(page);
  if (near?.texts?.length) {
    const chosen = chooseBestAmountFromTexts(near.texts, 'near-label-follow');
    if (chosen) return chosen;
  }

  // 2) Generiska selektorer
  const gen = await getByGenericSelectors(page);
  if (gen?.text) {
    const n = parseAmount(gen.text);
    if (n != null && n >= 50 && !isBadText(gen.text)) return { ...gen, amount: n };
  }

  // 3) Body-max fallback
  const body = await getBodyMax(page);
  if (body) return body;

  // 4) Sista retryn
  await sleep(1500);
  const near2 = await getByLabelDOM(page);
  if (near2?.texts?.length) {
    const chosen = chooseBestAmountFromTexts(near2.texts, 'retry-near-label');
    if (chosen) return chosen;
  }
  const gen2 = await getByGenericSelectors(page);
  if (gen2?.text) {
    const n = parseAmount(gen2.text);
    if (n != null && n >= 50 && !isBadText(gen2.text)) return { ...gen2, amount: n };
  }

  return { text: null, amount: null, strategy: 'not-found' };
}

async function run() {
  const browser = await chromium.launch({ args: ['--no-sandbox'] }); // headless
  const context = await browser.newContext({
    viewport: { width: 1366, height: 900 },
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
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
  console.log('Om något ser konstigt ut: kika på debug.raw/debug.strategy i data.json.');
}

run().catch(err => { console.error('Kritiskt fel:', err); process.exit(1); });
