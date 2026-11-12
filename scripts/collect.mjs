#!/usr/bin/env node
// Safnar dagsögu beggja veðurstöðva í data/daily.json.
//
// Ambient Weather skilar mest 288 mælingum í kalli (einum sólarhring í
// 5 mínútna upplausn) og leyfir eitt kall á sekúndu. Vafrinn getur því ekki
// sótt heilan mánuð eða ár á skikkanlegum tíma. Þetta skrifta keyrir einu
// sinni á nóttu (sjá .github/workflows/collect.yml), dregur hvern dag saman
// í fáeinar tölur og síðan les svo bara eina litla skrá.
//
//   node scripts/collect.mjs                 sækir þá daga sem vantar og síðustu
//                                            3 daga upp á nýtt
//   FROM=2026-01-01 node scripts/collect.mjs sækja allt upp á nýtt frá tilteknum degi

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

    for (let attempt = 0; attempt < 5; attempt++) {
        try {
            const res = await fetch(url);
            if (res.status === 429 || res.status >= 500) {
                await sleep(3000 * (attempt + 1));
                continue;
            }
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const json = await res.json();
            return Array.isArray(json) ? json : [];
        } catch (err) {
            if (attempt === 4) throw err;
            await sleep(3000 * (attempt + 1));
        }
    }
    throw new Error('Rate limited after 5 attempts');
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

async function main() {
    const data = (await loadExisting()) ?? { updated: null, stations: {}, days: {} };

    const todayStart = dayStart(dayKey(Date.now()));   // dagurinn í dag er ekki búinn
    const recent = todayStart - 3 * DAY;               // síðustu dagar eru alltaf sóttir aftur
    const fromEnv = (process.env.FROM || '').trim();
    if (fromEnv && !/^\d{4}-\d{2}-\d{2}$/.test(fromEnv)) {
        throw new Error('FROM verður að vera á forminu ÁÁÁÁ-MM-DD');
    }

    let failures = 0;
    for (const [id, st] of Object.entries(STATIONS)) {
        // Byrja þar sem stöðin á fyrst gögn, svo tómir dagar þar á undan séu
        // ekki sóttir aftur á hverri nóttu.
        const known = data.stations[id]?.firstDay;
        let first = dayStart(fromEnv || known || st.since);
        first = Math.max(first, dayStart(st.since));

        let fetched = 0, stored = 0;
        for (let start = first; start < todayStart; start += DAY) {
            const key = dayKey(start);
            // Dagar sem eru þegar komnir eru látnir vera. Þannig fyllir hver
            // keyrsla sjálf í göt eftir keyrslu sem mistókst eða rann út á tíma.
            if (!fromEnv && start < recent && data.days[key]?.[id]) continue;

            try {
                const summary = summarise(await fetchDay(st, start), start);
                if (summary) {
                    (data.days[key] ??= {})[id] = summary;
                    stored++;
                }
            } catch (err) {
                failures++;
                console.error(`  ${st.name} ${key}: ${err.message}`);
            }
            fetched++;
            if (fetched % 25 === 0) {
                console.log(`  ${st.name}: ${fetched} dagar sóttir, kominn að ${key}`);
                await save(data);     // geyma jafnóðum, ef verkið skyldi renna út á tíma
            }
            await sleep(1100);        // eitt kall á sekúndu
        }

        const mine = Object.keys(data.days).filter(k => data.days[k][id]).sort();
        data.stations[id] = { name: st.name, since: st.since, firstDay: mine[0] ?? null };
        console.log(`${st.name}: ${stored} dagar vistaðir af ${fetched} sóttum`);
        await save(data);
    }

    console.log(`Skrifað: ${Object.keys(data.days).length} dagar alls`);

    // Stök misheppnuð köll eru í lagi (næsta keyrsla fyllir í), en ef allt
    // bregst á keyrslan að sjást sem misheppnuð í GitHub.
    if (failures > 20) process.exit(1);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    main().catch(err => { console.error(err); process.exit(1); });
}
