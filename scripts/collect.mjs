#!/usr/bin/env node
// Safnar dagsögu beggja veðurstöðva í data/daily.json.
//
// Ambient Weather skilar mest 288 mælingum í kalli (einum sólarhring í
// 5 mínútna upplausn) og leyfir eitt kall á sekúndu. Vafrinn getur því ekki
// sótt heilan mánuð eða ár á skikkanlegum tíma. Þetta skrifta keyrir einu
// sinni á nóttu (sjá .github/workflows/collect.yml), dregur hvern dag saman
// í fáeinar tölur og síðan les svo bara eina litla skrá.
//
//   node scripts/collect.mjs                 síðustu 3 dagar upp á nýtt, svo eldri
//                                            saga sem vantar, nýjast fyrst
//   FROM=2026-01-01 node scripts/collect.mjs sækja allt upp á nýtt aftur að tilteknum degi
//   BUDGET_MIN=30                            hámarkstími; næsta keyrsla heldur áfram

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA_FILE = path.join(ROOT, 'data', 'daily.json');

// Sömu lyklar og eru þegar í síðunum sjálfum (aðeins lesaðgangur að veðurgögnum).
export const STATIONS = {
    a: {
        name: 'Árbær',
        mac: 'F8:B3:B7:83:67:29',
        apiKey: '36de8cc26f8c42eeb9a3f36917866318a4f5d3e393ae4130a38d4a6bf0cf1adc',
        appKey: '28d59914780d4f958a78fe0d9ed822ad6b6e32f77c45437690d81615d3f8daac',
        since: '2026-01-01',
    },
    b: {
        name: 'Vík',
        mac: '8C:4F:00:56:54:73',
        apiKey: '9fcadacc51744b73a07cd169ace3b0f66db277dac5054513907ce3554ec7fe45',
        appKey: '1b3f9bc1bd4b4288936cbc7c39345af2d07b7369d20b46cbae31fc16308e9157',
        since: '2026-10-19',   // stöðin var sett upp þann dag
    },
};

const DAY = 24 * 60 * 60 * 1000;
const SUNNY_WM2 = 120;            // sólgeislun sem telst „sólskin"
const sleep = ms => new Promise(r => setTimeout(r, ms));
const round1 = v => Math.round(v * 10) / 10;

const fToC = f => (f - 32) * 5 / 9;
const mphToMs = m => m * 0.44704;
const inToMm = i => i * 25.4;

// Ísland er á UTC allt árið, svo dagurinn er einfaldlega UTC-dagurinn.
export const dayKey = ms => new Date(ms).toISOString().slice(0, 10);
export const dayStart = key => Date.parse(key + 'T00:00:00Z');

const median = arr => {
    if (!arr.length) return null;
    const s = [...arr].sort((x, y) => x - y);
    const m = Math.floor(s.length / 2);
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/** Dregur mælingar eins dags saman. Skilar null ef engin raunmæling er til. */
export function summarise(records, startMs) {
    const endMs = startMs + DAY;
    const rows = (records || [])
        .filter(r => r && typeof r.tempf === 'number' &&
                     r.dateutc >= startMs && r.dateutc < endMs)
        .sort((x, y) => x.dateutc - y.dateutc);
    if (!rows.length) return null;

    const temps = rows.map(r => fToC(r.tempf));
    const winds = rows.map(r => r.windspdmph_avg10m ?? r.windspeedmph)
        .filter(v => typeof v === 'number').map(mphToMs);
    // maxdailygust er hæsta hviða dagsins að mati stöðvarinnar sjálfrar og
    // nær hviðum sem falla milli 5 mínútna mælinga. Fyrstu mínútur dagsins
    // er henni sleppt, hún gæti enn borið tölu gærdagsins.
    const settled = rows.filter(r => r.dateutc >= startMs + 10 * 60 * 1000);
    const gusts = [
        ...rows.map(r => r.windgustmph),
        ...settled.map(r => r.maxdailygust),
    ].filter(v => typeof v === 'number').map(mphToMs);

    // dailyrainin núllstillist á miðnætti. Fyrstu mínúturnar geta enn borið
    // heildartölu gærdagsins, svo þær eru ekki teknar með í hámarkið.
    const rains = settled.map(r => r.dailyrainin).filter(v => typeof v === 'number');

    // Bil milli mælinga er ekki alltaf 5 mínútur (eldri gögn eru grisjuð),
    // svo sólskinsstundir eru reiknaðar út frá raunverulegu bili.
    const gaps = [];
    for (let i = 1; i < rows.length; i++) gaps.push(rows[i].dateutc - rows[i - 1].dateutc);
    const stepMin = (median(gaps) ?? 5 * 60 * 1000) / 60000;
    const sunny = rows.filter(r => (r.solarradiation ?? 0) >= SUNNY_WM2).length;

    const mean = a => a.reduce((s, v) => s + v, 0) / a.length;

    return {
        tMax: round1(Math.max(...temps)),
        tMin: round1(Math.min(...temps)),
        tMean: round1(mean(temps)),
        wMean: winds.length ? round1(mean(winds)) : null,
        gustMax: gusts.length ? round1(Math.max(...gusts)) : null,
        rain: rains.length ? round1(inToMm(Math.max(...rains))) : 0,
        sunH: round1(Math.min(24, sunny * stepMin / 60)),
        n: rows.length,
        // Hve margar klukkustundir dagsins mælingarnar spanna. Síðan notar
        // þetta til að sleppa hálfum dögum (t.d. deginum sem stöð er sett upp).
        cov: round1((rows[rows.length - 1].dateutc - rows[0].dateutc) / 3600000),
    };
}

async function fetchDay(st, startMs) {
    const url = `https://rt.ambientweather.net/v1/devices/${st.mac}` +
        `?apiKey=${st.apiKey}&applicationKey=${st.appKey}` +
        // endDate er innifalið, svo mínus 1 ms heldur miðnæturmælingu næsta
        // dags úti og 288 mælingar ná þá nákvæmlega yfir daginn.
        `&endDate=${startMs + DAY - 1}&limit=288`;

    let lastErr = null;
    for (let attempt = 0; attempt < 4; attempt++) {
        try {
            // Án tímamarka getur kall hangið í fimm mínútur ef þjónninn svarar ekki.
            const res = await fetch(url, {
                signal: AbortSignal.timeout(20000),
                headers: { 'Accept': 'application/json', 'User-Agent': 'vedur.ragna.is dagsaga (github.com/ragna-bjorg/vedur)' },
            });
            if (res.status === 429 || res.status >= 500) {
                lastErr = new Error(`HTTP ${res.status}`);
                await sleep(2500 * (attempt + 1));
                continue;
            }
            if (!res.ok) {
                const body = (await res.text()).slice(0, 200);
                throw new Error(`HTTP ${res.status} ${body}`);
            }
            const json = await res.json();
            return Array.isArray(json) ? json : [];
        } catch (err) {
            lastErr = err;
            if (attempt < 3) await sleep(2500 * (attempt + 1));
        }
    }
    throw lastErr ?? new Error('Óþekkt villa');
}

async function loadExisting() {
    try {
        const parsed = JSON.parse(await readFile(DATA_FILE, 'utf8'));
        if (parsed && typeof parsed.days === 'object') return parsed;
    } catch { /* skráin er ekki til enn þá */ }
    return null;
}

async function save(data) {
    data.days = Object.fromEntries(Object.entries(data.days).sort(([x], [y]) => x.localeCompare(y)));
    data.updated = new Date().toISOString();
    await mkdir(path.dirname(DATA_FILE), { recursive: true });
    await writeFile(DATA_FILE, JSON.stringify(data, null, 1) + '\n');
}

/** Hvaða daga á að sækja fyrir eina stöð, í forgangsröð: fyrst síðustu
    þrír dagar, svo dagar sem mistókust síðast, og loks eldri saga, nýjast fyrst. */
export function plan(state, since, todayStart, fromKey) {
    const keys = [];
    const push = k => { if (k >= since && !keys.includes(k)) keys.push(k); };
    for (let i = 1; i <= 3; i++) push(dayKey(todayStart - i * DAY));
    if (fromKey) {
        for (let t = todayStart - DAY; t >= dayStart(fromKey); t -= DAY) push(dayKey(t));
        return keys;
    }
    (state.retry || []).forEach(push);
    const resume = state.oldest ? dayStart(state.oldest) - DAY : todayStart - DAY;
    for (let t = resume; t >= dayStart(since); t -= DAY) push(dayKey(t));
    return keys;
}

export async function main() {
    const data = (await loadExisting()) ?? { updated: null, stations: {}, days: {} };

    const started = Date.now();
    const budgetMs = Number(process.env.BUDGET_MIN || 30) * 60 * 1000;
    const todayStart = dayStart(dayKey(Date.now()));   // dagurinn í dag er ekki búinn
    const recentFrom = dayKey(todayStart - 3 * DAY);
    const fromEnv = (process.env.FROM || '').trim();
    if (fromEnv && !/^\d{4}-\d{2}-\d{2}$/.test(fromEnv)) {
        throw new Error('FROM verður að vera á forminu ÁÁÁÁ-MM-DD');
    }

    let failures = 0, successes = 0, outOfTime = false;

    // Vík á undan: stutt saga, og einvígið þarf báðar stöðvar.
    for (const id of ['b', 'a']) {
        const st = STATIONS[id];
        const state = data.stations[id] = { name: st.name, since: st.since,
            oldest: data.stations[id]?.oldest ?? null, retry: data.stations[id]?.retry ?? [] };
        const todo = plan(state, st.since, todayStart, fromEnv);

        let fetched = 0, stored = 0;
        for (const key of todo) {
            if (Date.now() - started > budgetMs) { outOfTime = true; break; }

            const done = () => {
                state.retry = state.retry.filter(k => k !== key);
                if (!state.oldest || key < state.oldest) state.oldest = key;
            };
            // Eldri dagar sem eru þegar komnir eru ekki sóttir aftur.
            if (!fromEnv && key < recentFrom && data.days[key]?.[id]) { done(); continue; }

            try {
                const summary = summarise(await fetchDay(st, dayStart(key)), dayStart(key));
                if (summary) { (data.days[key] ??= {})[id] = summary; stored++; }
                successes++;
                done();
            } catch (err) {
                failures++;
                if (!state.retry.includes(key)) state.retry.push(key);
                console.error(`  ${st.name} ${key}: ${err.name}: ${err.message}`);
                if (failures >= 8 && successes === 0) {
                    throw new Error('Ekkert kall kemst í gegn. Hætti í stað þess að reyna alla söguna.');
                }
            }
            fetched++;
            if (fetched % 20 === 0) {
                console.log(`  ${st.name}: ${fetched} dagar sóttir, kominn aftur að ${key}`);
                await save(data);     // geyma jafnóðum
            }
            await sleep(1100);        // eitt kall á sekúndu
        }
        console.log(`${st.name}: ${stored} dagar vistaðir af ${fetched} sóttum` +
                    (state.oldest ? `, saga nær aftur að ${state.oldest}` : ''));
        await save(data);
        if (outOfTime) break;
    }

    console.log(`Skrifað: ${Object.keys(data.days).length} dagar alls` +
                (outOfTime ? '. Tíminn kláraðist, næsta keyrsla heldur áfram með eldri sögu.' : ''));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    main().catch(err => { console.error(err); process.exit(1); });
}
