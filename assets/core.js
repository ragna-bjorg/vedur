/* Sameiginlegur kjarni fyrir einvígið, metavegginn, bingóið og giskleikinn.
   Les data/daily.json (sem næturverkið í GitHub skrifar) og reiknar allt
   annað út frá henni, svo reglunum má breyta án þess að safna gögnum upp á nýtt. */
(function (root) {
    'use strict';

    const STATIONS = {
        a: { id: 'a', name: 'Árbær', dative: 'Árbæ', place: 'Ártúnsholt — Reykjavík', color: '#4A3524', lat: 64.12, lon: -21.80 },
        b: { id: 'b', name: 'Vík',   dative: 'Vík',  place: 'Vík í Mýrdal',           color: '#D8B077', lat: 63.42, lon: -19.01 },
    };

    const DATA_URLS = [
        // Hrá skrá beint úr geymslunni: uppfærist um leið og næturverkið vistar,
        // óháð því hvort GitHub Pages endurbyggir síðuna.
        'https://raw.githubusercontent.com/ragna-bjorg/vedur/main/data/daily.json',
        '/data/daily.json',
    ];

    const MONTHS = ['janúar', 'febrúar', 'mars', 'apríl', 'maí', 'júní', 'júlí',
                    'ágúst', 'september', 'október', 'nóvember', 'desember'];
    const MONTHS_SHORT = ['jan.', 'feb.', 'mars', 'apr.', 'maí', 'júní', 'júlí',
                          'ágú.', 'sep.', 'okt.', 'nóv.', 'des.'];

    const MIN_COVERAGE_H = 20;   // dagur telst aðeins ef mælingar spanna hann nær allan
    const TIE_MARGIN = 3;        // minni munur en þetta er jafntefli

    // Vægi þáttanna. Rok, rigning og sólarleysi skipta meira máli en hitinn,
    // annars vinnur hlýrri staðurinn nær alltaf. Samtals 100 stig.
    const WEIGHTS = { wind: 0.35, rain: 0.35, temp: 0.15, sun: 15 };
    const SUN_FLOOR_HOURS = 2;    // dagsstig: fullt hús krefst a.m.k. 2 sólskinsstunda
    const SUN_FLOOR_WM2 = 200;    // stig núna: fullt hús krefst a.m.k. 200 W/m²

    const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
    const pad = n => String(n).padStart(2, '0');

    /* ------------------------------------------------------------ dagsetningar */
    // Ísland er á UTC allt árið, svo UTC-dagurinn er íslenski dagurinn.
    const todayKey = (now = Date.now()) => new Date(now).toISOString().slice(0, 10);
    const addDays = (key, n) =>
        new Date(Date.parse(key + 'T00:00:00Z') + n * 86400000).toISOString().slice(0, 10);
    const monthKey = key => key.slice(0, 7);
    const daysInMonth = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate();   // m = 1–12
    const shortDate = key => `${Number(key.slice(8, 10))}. ${MONTHS_SHORT[Number(key.slice(5, 7)) - 1]}`;

    /* ----------------------------------------------------------------- stigagjöf */
    const scoreTemp = c => clamp(((c - 2) / 14) * 100, 0, 100);       // 2°C = 0, 16°C = 100
    const scoreWind = ms => clamp(100 - (ms / 12) * 100, 0, 100);     // logn = 100, 12 m/s = 0
    const scoreRainDaily = mm => mm <= 0 ? 100 : clamp(100 - Math.sqrt(mm / 12) * 100, 0, 100);

    const usable = s => !!s && typeof s.tMean === 'number' && (s.cov ?? 0) >= MIN_COVERAGE_H;

    /** Sólarstig beggja staða. Sá sem fær meiri sól fær fleiri stig, en fullt
        hús fæst aðeins ef sólin nær lágmarkinu (floor). Í myrkri fá báðir núll,
        svo sólin skekkir ekkert á nóttunni eða í skammdeginu. */
    function sunPoints(a, b, floor) {
        const ref = Math.max(a, b, floor);
        return { a: (a / ref) * WEIGHTS.sun, b: (b / ref) * WEIGHTS.sun };
    }

    /** Stig beggja stöðva fyrir einn dag, eða null ef önnur hvor er ófullnægjandi. */
    function scoreDay(entry) {
        if (!entry || !usable(entry.a) || !usable(entry.b)) return null;

        const base = s => WEIGHTS.temp * scoreTemp(s.tMean) +
                          WEIGHTS.wind * scoreWind(s.wMean ?? 0) +
                          WEIGHTS.rain * scoreRainDaily(s.rain ?? 0);
        const sun = sunPoints(entry.a.sunH ?? 0, entry.b.sunH ?? 0, SUN_FLOOR_HOURS);

        const a = base(entry.a) + sun.a;
        const b = base(entry.b) + sun.b;
        const diff = a - b;
        return { a, b, winner: Math.abs(diff) < TIE_MARGIN ? 'tie' : (diff > 0 ? 'a' : 'b') };
    }

    /** Allir dagar í tímaröð með stigum (score = null ef ekki er hægt að dæma). */
    function scoredDays(data, filter) {
        return Object.keys(data.days || {}).sort()
            .filter(k => !filter || filter(k))
            .map(k => ({ key: k, a: data.days[k].a || null, b: data.days[k].b || null,
                         score: scoreDay(data.days[k]) }));
    }

    function tally(days) {
        const t = { a: 0, b: 0, tie: 0, played: 0 };
        days.forEach(d => { if (d.score) { t[d.score.winner]++; t.played++; } });
        return t;
    }

    const duelMonth = (data, ym) => {
        const days = scoredDays(data, k => monthKey(k) === ym);
        return { days, tally: tally(days) };
    };
    const duelAll = data => {
        const days = scoredDays(data).filter(d => d.score);
        return { tally: tally(days), first: days.length ? days[0].key : null };
    };

    /* ---------------------------------------------------------------------- met */
    function longestDrySpell(list) {
        let best = { len: 0, end: null }, run = 0;
        list.forEach(({ key, s, prev }) => {
            // Rof í dagaröðinni slítur þurrkatímabilið.
            if (prev && addDays(prev, 1) !== key) run = 0;
            if ((s.rain ?? 0) < 0.2) { run++; if (run > best.len) best = { len: run, end: key }; }
            else run = 0;
        });
        return best.len ? { value: best.len, key: best.end } : null;
    }

    /** Met einnar stöðvar á einu ári. Hvert met er { value, key } eða null. */
    function records(data, id, year) {
        const list = [];
        let prev = null;
        Object.keys(data.days || {}).sort().forEach(key => {
            if (!key.startsWith(String(year))) return;
            const s = data.days[key][id];
            if (!usable(s)) return;
            list.push({ key, s, prev });
            prev = key;
        });
        if (!list.length) return null;

        const best = (pick, cmp) => {
            let out = null;
            list.forEach(({ key, s }) => {
                const v = pick(s);
                if (typeof v !== 'number') return;
                if (!out || cmp(v, out.value)) out = { value: v, key };
            });
            return out;
        };
        const hi = (x, y) => x > y, lo = (x, y) => x < y;

        return {
            first: list[0].key,
            count: list.length,
            warmest: best(s => s.tMax, hi),
            coldest: best(s => s.tMin, lo),
            gust: best(s => s.gustMax, hi),
            wettest: best(s => s.rain, hi),
            sunniest: best(s => s.sunH, hi),
            dry: longestDrySpell(list),
        };
    }

    /* -------------------------------------------------------------------- bingó */
    // Lítill slembigjafi með fræi, svo allir gestir fá sama spjald í sama mánuði.
    function mulberry32(seed) {
        let t = seed >>> 0;
        return () => {
            t += 0x6D2B79F5;
            let r = Math.imul(t ^ (t >>> 15), 1 | t);
            r ^= r + Math.imul(r ^ (r >>> 7), 61 | r);
            return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
        };
    }

    const each = (d, fn) => ['a', 'b'].some(id => usable(d[id]) && fn(d[id]));
    const both = (d, fn) => usable(d.a) && usable(d.b) && fn(d.a) && fn(d.b);
    const anyDay = fn => days => days.some(d => each(d, fn));
    const streak = (days, fn, n) => {
        let run = 0, prev = null;
        for (const d of days) {
            if (prev && addDays(prev, 1) !== d.key) run = 0;
            run = fn(d) ? run + 1 : 0;
            if (run >= n) return true;
            prev = d.key;
        }
        return false;
    };
    const stationStreak = (days, fn, n) =>
        ['a', 'b'].some(id => streak(days, d => usable(d[id]) && fn(d[id]), n));
    const count = (days, fn) => days.filter(fn).length;
    const sumRain = (days, id) => days.reduce((s, d) => s + (usable(d[id]) ? (d[id].rain ?? 0) : 0), 0);

    const WINTER = [10, 11, 12, 1, 2, 3, 4], SUMMER = [6, 7, 8], SHOULDER = [5, 9];
    const DARK = [10, 11, 12, 1, 2], BRIGHT = [3, 4, 5, 6, 7, 8, 9];

    const BINGO_POOL = [
        { id: 'gust20',  label: 'Hviða yfir 20 m/s',            test: anyDay(s => (s.gustMax ?? 0) >= 20) },
        { id: 'gust30',  label: 'Hviða yfir 30 m/s',            test: anyDay(s => (s.gustMax ?? 0) >= 30) },
        { id: 'windy',   label: 'Hvass dagur, yfir 10 m/s',     test: anyDay(s => (s.wMean ?? 0) >= 10) },
        { id: 'calm',    label: 'Logn\u00ADdagur, undir 2 m/s',       test: anyDay(s => (s.wMean ?? 99) < 2) },
        { id: 'dryBoth', label: 'Þurrt á báðum stöðum',         test: days => days.some(d => both(d, s => (s.rain ?? 0) < 0.2)) },
        { id: 'wetBoth', label: 'Rigning á báðum stöðum',       test: days => days.some(d => both(d, s => (s.rain ?? 0) >= 1)) },
        { id: 'dry3',    label: 'Þrír þurrir dagar í röð',      test: days => stationStreak(days, s => (s.rain ?? 0) < 0.2, 3) },
        { id: 'rain10',  label: 'Yfir 10 mm á einum degi',      test: anyDay(s => (s.rain ?? 0) >= 10) },
        { id: 'rain25',  label: 'Yfir 25 mm á einum degi',      test: anyDay(s => (s.rain ?? 0) >= 25) },
        { id: 'rain50',  label: '50 mm samtals í mánuð\u00ADinum',    test: days => sumRain(days, 'a') >= 50 || sumRain(days, 'b') >= 50 },
        { id: 'vikWarm', label: 'Vík hlýrri í 5 daga',          test: days => count(days, d => usable(d.a) && usable(d.b) && d.b.tMean > d.a.tMean) >= 5 },
        { id: 'arbWarm', label: 'Árbær hlýrri í 5 daga',        test: days => count(days, d => usable(d.a) && usable(d.b) && d.a.tMean > d.b.tMean) >= 5 },
        { id: 'diff5',   label: '5° munur á stöðv\u00ADunum',         test: days => days.some(d => usable(d.a) && usable(d.b) && Math.abs(d.a.tMean - d.b.tMean) >= 5) },
        { id: 'same',    label: 'Sami meðal\u00ADhiti á báðum',       test: days => days.some(d => usable(d.a) && usable(d.b) && Math.abs(d.a.tMean - d.b.tMean) <= 0.2) },
        { id: 'streakA', label: 'Árbær vinnur 3 daga í röð',    test: days => streak(days, d => d.score && d.score.winner === 'a', 3) },
        { id: 'streakB', label: 'Vík vinnur 3 daga í röð',      test: days => streak(days, d => d.score && d.score.winner === 'b', 3) },
        { id: 'tie',     label: 'Jafntefli í einvíginu',        test: days => days.some(d => d.score && d.score.winner === 'tie') },
        { id: 'blowout', label: 'Stór\u00ADsigur, 30 stiga munur',    test: days => days.some(d => d.score && Math.abs(d.score.a - d.score.b) >= 30) },

        { id: 'frostA',  label: 'Frost í Árbæ',   months: WINTER.concat(SHOULDER), test: days => days.some(d => usable(d.a) && d.a.tMin < 0) },
        { id: 'frostB',  label: 'Frost í Vík',    months: WINTER.concat(SHOULDER), test: days => days.some(d => usable(d.b) && d.b.tMin < 0) },
        { id: 'cold5',   label: 'Kaldara en -5°C', months: [11, 12, 1, 2, 3],      test: anyDay(s => s.tMin <= -5) },
        { id: 'warm10',  label: 'Hiti yfir 10°C',  months: WINTER,                 test: anyDay(s => s.tMax >= 10) },
        { id: 'warm15',  label: 'Hiti yfir 15°C',  months: SHOULDER,               test: anyDay(s => s.tMax >= 15) },
        { id: 'warm20',  label: 'Hiti yfir 20°C',  months: SUMMER,                 test: anyDay(s => s.tMax >= 20) },
        { id: 'sun3',    label: 'Þrjár sólskins\u00ADstundir', months: DARK,             test: anyDay(s => (s.sunH ?? 0) >= 3) },
        { id: 'sun8',    label: 'Átta sólskins\u00ADstundir',  months: BRIGHT,           test: anyDay(s => (s.sunH ?? 0) >= 8) },
    ];

    const BINGO_LINES = [
        [0, 1, 2, 3], [4, 5, 6, 7], [8, 9, 10, 11], [12, 13, 14, 15],
        [0, 4, 8, 12], [1, 5, 9, 13], [2, 6, 10, 14], [3, 7, 11, 15],
        [0, 5, 10, 15], [3, 6, 9, 12],
    ];

    /** Spjald mánaðarins: 16 reitir, þeir sömu fyrir alla gesti. */
    function bingoCard(ym) {
        const [y, m] = ym.split('-').map(Number);
        const pool = BINGO_POOL.filter(s => !s.months || s.months.includes(m));
        const rand = mulberry32(y * 100 + m);
        const shuffled = pool.map(s => [rand(), s]).sort((p, q) => p[0] - q[0]).map(p => p[1]);
        return shuffled.slice(0, 16);
    }

    function bingoState(data, ym) {
        const card = bingoCard(ym);
        const days = scoredDays(data, k => monthKey(k) === ym);
        const hit = card.map(sq => { try { return !!sq.test(days); } catch (e) { return false; } });
        const lines = BINGO_LINES.filter(line => line.every(i => hit[i]));
        return { card, hit, lines, done: hit.filter(Boolean).length, days: days.length };
    }

    /* ----------------------------------------------------------------- giskleikur */
    const GUESS_KEY = 'vedur:gisk:v1';

    function loadGuesses() {
        try {
            const parsed = JSON.parse(localStorage.getItem(GUESS_KEY) || '{}');
            return parsed && typeof parsed === 'object' ? parsed : {};
        } catch (e) { return {}; }
    }
    function saveGuesses(all) {
        try { localStorage.setItem(GUESS_KEY, JSON.stringify(all)); return true; }
        catch (e) { return false; }
    }

    /** Ber gisk og spá saman við raunverulegan hámarkshita. */
    function judgeGuess(guess, entry) {
        const out = { stations: {}, user: 0, forecast: 0, decided: 0 };
        ['a', 'b'].forEach(id => {
            const actual = entry && usable(entry[id]) ? entry[id].tMax : null;
            const g = guess[id], f = guess['f' + id];
            if (typeof actual !== 'number' || typeof g !== 'number') return;
            const ue = Math.abs(g - actual);
            const fe = typeof f === 'number' ? Math.abs(f - actual) : null;
            let result = 'none';
            if (fe !== null) {
                result = Math.abs(ue - fe) < 0.05 ? 'tie' : (ue < fe ? 'user' : 'forecast');
                if (result === 'user') out.user++;
                if (result === 'forecast') out.forecast++;
                out.decided++;
            }
            out.stations[id] = { actual, guess: g, forecast: f ?? null, userErr: ue, fcErr: fe, result };
        });
        return out;
    }

    /* ---------------------------------------------------------------------- gögn */
    async function loadDaily() {
        let lastErr = null;
        for (const url of DATA_URLS) {
            try {
                const res = await fetch(url, { cache: 'no-cache' });
                if (!res.ok) throw new Error('HTTP ' + res.status);
                const json = await res.json();
                if (json && typeof json.days === 'object') return json;
                throw new Error('Óvænt snið');
            } catch (e) { lastErr = e; }
        }
        throw lastErr || new Error('Gögn fundust ekki');
    }

    root.Vedur = {
        STATIONS, MONTHS, MONTHS_SHORT, TIE_MARGIN, BINGO_LINES,
        WEIGHTS, SUN_FLOOR_WM2, sunPoints,
        todayKey, addDays, monthKey, daysInMonth, shortDate, pad,
        scoreTemp, scoreWind, scoreRainDaily, usable,
        scoreDay, scoredDays, tally, duelMonth, duelAll,
        records, bingoCard, bingoState,
        loadGuesses, saveGuesses, judgeGuess, loadDaily,
    };
})(typeof window !== 'undefined' ? window : globalThis);
