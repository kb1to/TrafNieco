/* ============================================================
   TRAF NIEČO — game logic
   stav: menu → countdown → playing ⇄ paused → over
   ============================================================ */

(() => {
    "use strict";

    const $ = (s) => document.querySelector(s);
    const field = $("#field");
    const popupsLayer = $("#popups");
    const header = $("#header");

    const params = new URLSearchParams(location.search);
    const QUICK = params.has("quick");

    // ---------------- stav hry

    const S = {
        state: "menu",
        score: 0,
        combo: 0,
        hits: 0,
        missClicks: 0,
        escaped: 0,
        bombs: 0,
        reactions: [],
        timeLeft: 0,
        roundLen: (QUICK ? 8 : 45) * 1000,
        quick: QUICK,
    };

    let slots = [];
    let activeMoles = new Map(); // slot index -> mole object
    let spawnTimer = null;
    let tickTimer = null;
    let lastTick = 0;
    let countTimer = null;

    function setState(s) {
        S.state = s;
        document.getElementById("game").dataset.state = s;
    }

    // ---------------- uložisko skóre

    const KEY = "traf-nieco-scores-v1";

    function loadScores() {
        try {
            const raw = localStorage.getItem(KEY);
            const arr = raw ? JSON.parse(raw) : [];
            return Array.isArray(arr) ? arr : [];
        } catch (e) {
            return [];
        }
    }

    function saveScore(rec) {
        try {
            const arr = loadScores();
            arr.push(rec);
            arr.sort((a, b) => b.score - a.score);
            localStorage.setItem(KEY, JSON.stringify(arr.slice(0, 30)));
        } catch (e) { /* private mode — skóre sa len neuloží */ }
    }

    function bestScore() {
        const arr = loadScores();
        return arr.length ? arr[0].score : 0;
    }

    // ---------------- zvuk (WebAudio, bez súborov)

    const AudioFX = (() => {
        let ctx = null;
        let muted = false;

        function ensure() {
            if (muted) return null;
            if (!ctx) {
                const AC = window.AudioContext || window.webkitAudioContext;
                if (!AC) return null;
                ctx = new AC();
            }
            if (ctx.state === "suspended") ctx.resume();
            return ctx;
        }

        function blip(freq, dur, type, vol, slide) {
            const c = ensure();
            if (!c) return;
            const o = c.createOscillator();
            const g = c.createGain();
            o.type = type || "square";
            o.frequency.setValueAtTime(freq, c.currentTime);
            if (slide) {
                o.frequency.exponentialRampToValueAtTime(
                    Math.max(30, freq + slide), c.currentTime + dur);
            }
            g.gain.setValueAtTime(vol || 0.07, c.currentTime);
            g.gain.exponentialRampToValueAtTime(0.0001, c.currentTime + dur);
            o.connect(g).connect(c.destination);
            o.start();
            o.stop(c.currentTime + dur + 0.02);
        }

        function noise(dur, vol) {
            const c = ensure();
            if (!c) return;
            const len = Math.floor(c.sampleRate * dur);
            const buf = c.createBuffer(1, len, c.sampleRate);
            const d = buf.getChannelData(0);
            for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len);
            const src = c.createBufferSource();
            const g = c.createGain();
            g.gain.value = vol || 0.15;
            src.buffer = buf;
            src.connect(g).connect(c.destination);
            src.start();
        }

        return {
            hit(combo) {
                blip(420 + Math.min(combo, 12) * 35, 0.09, "square", 0.07);
                blip(840 + Math.min(combo, 12) * 35, 0.06, "square", 0.04);
            },
            bomb() {
                noise(0.32, 0.22);
                blip(120, 0.3, "sawtooth", 0.12, -70);
            },
            miss() {
                blip(150, 0.1, "square", 0.05, -60);
            },
            spawn() {
                blip(640, 0.045, "square", 0.025);
            },
            count(final) {
                blip(final ? 880 : 520, final ? 0.22 : 0.12, "square", 0.06);
            },
            over() {
                blip(392, 0.16, "square", 0.07);
                setTimeout(() => blip(330, 0.16, "square", 0.07), 160);
                setTimeout(() => blip(262, 0.3, "square", 0.07), 320);
            },
            newBest() {
                [523, 659, 784, 1047].forEach((f, i) =>
                    setTimeout(() => blip(f, 0.12, "square", 0.07), i * 110));
            },
            toggle() {
                muted = !muted;
                return muted;
            },
        };
    })();

    // ---------------- pixel art (cieľ a bomba ako SVG)

    function pixelSVG(rows, pal, cell) {
        let out = "";
        rows.forEach((row, r) => {
            let i = 0;
            while (i < row.length) {
                if (row[i] === ".") { i++; continue; }
                let j = i;
                while (j < row.length && row[j] === row[i]) j++;
                out += `<rect x="${i * cell}" y="${r * cell}" width="${(j - i) * cell}" height="${cell}" fill="${pal[row[i]]}"/>`;
                i = j;
            }
        });
        const w = Math.max(...rows.map((r) => r.length)) * cell;
        const h = rows.length * cell;
        return `<svg viewBox="0 0 ${w} ${h}" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">${out}</svg>`;
    }

    const TARGET_FACE = [
        "FFFFFFF",
        "FFFRFFF",
        "FFRFRFF",
        "FRFCFRF",
        "FFRFRFF",
        "FFFRFFF",
        "FFFFFFF",
    ];

    const TARGET_ROWS = ["." + "T".repeat(7) + "."]
        .concat(TARGET_FACE.map((r) => "T" + r + "T"))
        .concat(["." + "T".repeat(7) + "."])
        .concat(Array(6).fill("...PPD..."));

    const TARGET_PAL = {
        T: "#45291f", F: "#efe3cd", R: "#d84b5c", C: "#d84b5c",
        P: "#7a4b33", D: "#4e2f22",
    };

    const BOMB_ROWS = [
        "....SS...",
        "....F....",
        "....F....",
        "..BBBBB..",
        ".BBBBBBB.",
        ".BWWBBBB.",
        "BBBBBBBBB",
        "BBBBBBBBB",
        "BBBBBBBBB",
        ".BBBBBBB.",
        ".BBBBBBB.",
        "..BBBBB..",
    ];

    const BOMB_PAL = {
        S: "#ffe9a8", F: "#8a5a38", B: "#1a1430", W: "#6a5a9e",
    };

    const TARGET_SVG = pixelSVG(TARGET_ROWS, TARGET_PAL, 8);
    const BOMB_SVG = pixelSVG(BOMB_ROWS, BOMB_PAL, 8);

    // ---------------- HUD

    const hudScore = $("#hud-score");
    const hudTime = $("#hud-time");
    const hudCombo = $("#hud-combo");
    const hudBest = $("#hud-best");

    function multiplier() {
        return 1 + Math.min(4, Math.floor(S.combo / 4));
    }

    function updateHUD() {
        hudScore.textContent = S.score;
        hudTime.textContent = Math.ceil(S.timeLeft / 1000);
        const m = multiplier();
        hudCombo.textContent = "\u00d7" + m;
        hudCombo.classList.toggle("hot", m > 1);
        hudBest.textContent = Math.max(bestScore(), S.score);
    }

    // ---------------- popupy s bodmi

    function popup(fieldX, fieldY, text, bad) {
        const el = document.createElement("div");
        el.className = "popup" + (bad ? " bad" : "");
        el.textContent = text;
        el.style.left = fieldX + "px";
        el.style.top = fieldY + "px";
        popupsLayer.appendChild(el);
        setTimeout(() => el.remove(), 780);
    }

    // ---------------- header

    function setHeader(visible) {
        header.classList.toggle("visible", visible);
    }

    // ---------------- pole

    function buildField() {
        slots = [];
        for (let i = 0; i < 12; i++) {
            const slot = document.createElement("div");
            slot.className = "slot";
            field.insertBefore(slot, popupsLayer);
            slots.push(slot);
        }
    }

    function freeSlot() {
        const free = [];
        for (let i = 0; i < slots.length; i++) {
            if (!activeMoles.has(i)) free.push(i);
        }
        if (!free.length) return -1;
        return free[(Math.random() * free.length) | 0];
    }

    function spawnOne() {
        if (S.state !== "playing") return;
        const idx = freeSlot();
        if (idx < 0) return;

        const factor = 1 - S.timeLeft / S.roundLen;
        const isBomb = Math.random() < 0.16 + factor * 0.08;

        const el = document.createElement("div");
        el.className = "mole" + (isBomb ? " bomb" : "");
        el.innerHTML = '<span class="whack-flash">' +
            (isBomb ? BOMB_SVG : TARGET_SVG) + "</span>";

        const upFor = S.quick
            ? 950 - factor * 350 + Math.random() * 180
            : Math.max(720, 1500 - factor * 780) * (0.9 + Math.random() * 0.2);

        const mole = { el, bomb: isBomb, bornAt: performance.now(), upFor, whacked: false, hideTimer: null };
        activeMoles.set(idx, mole);
        slots[idx].appendChild(el);

        requestAnimationFrame(() => requestAnimationFrame(() => {
            if (activeMoles.get(idx) === mole) el.classList.add("up");
        }));
        AudioFX.spawn();

        mole.hideTimer = setTimeout(() => {
            if (activeMoles.get(idx) !== mole || mole.whacked) return;
            if (!isBomb) S.escaped++;
            retire(idx);
        }, upFor);
    }

    function retire(idx) {
        const mole = activeMoles.get(idx);
        if (!mole) return;
        activeMoles.delete(idx);
        if (mole.hideTimer) clearTimeout(mole.hideTimer);
        mole.el.classList.remove("up");
        setTimeout(() => mole.el.remove(), 170);
    }

    function clearMoles() {
        [...activeMoles.keys()].forEach(retire);
    }

    // ---------------- spawn cyklus

    function scheduleSpawn() {
        if (S.state !== "playing") return;
        const factor = 1 - S.timeLeft / S.roundLen;
        const base = S.quick ? 640 : 1150;
        const min = S.quick ? 330 : 500;
        const delay = Math.max(min, base - factor * (base - min)) *
            (0.85 + Math.random() * 0.3);
        spawnTimer = setTimeout(() => {
            spawnOne();
            scheduleSpawn();
        }, delay);
    }

    function tick() {
        const now = performance.now();
        S.timeLeft -= now - lastTick;
        lastTick = now;
        if (S.timeLeft <= 0) {
            S.timeLeft = 0;
            updateHUD();
            endRound();
            return;
        }
        updateHUD();
    }

    // ---------------- zásahy

    function fieldPoint(e) {
        const r = field.getBoundingClientRect();
        return { x: e.clientX - r.left, y: e.clientY - r.top };
    }

    function onPointerDown(e) {
        if (S.state !== "playing") return;

        const moleEl = e.target.closest(".mole");
        const { x, y } = fieldPoint(e);

        if (moleEl) {
            const idx = slots.indexOf(moleEl.parentElement);
            const mole = activeMoles.get(idx);
            if (!mole || mole.whacked) return;
            mole.whacked = true;
            if (mole.hideTimer) clearTimeout(mole.hideTimer);
            activeMoles.delete(idx);

            if (mole.bomb) {
                S.bombs++;
                S.combo = 0;
                S.score = Math.max(0, S.score - 200);
                moleEl.classList.add("boomed");
                field.classList.remove("shake");
                void field.offsetWidth;
                field.classList.add("shake");
                popup(x, y, "-200", true);
                AudioFX.bomb();
            } else {
                const react = performance.now() - mole.bornAt;
                S.reactions.push(react);
                S.combo++;
                S.hits++;
                const ratio = Math.max(0, 1 - react / mole.upFor);
                const pts = Math.round((100 + 90 * ratio) * multiplier() / 10) * 10;
                S.score += pts;
                moleEl.classList.add("whacked");
                popup(x, y, "+" + pts, false);
                AudioFX.hit(S.combo);
            }

            moleEl.classList.remove("up");
            setTimeout(() => moleEl.remove(), 200);
            updateHUD();
            return;
        }

        // klik do prázdna
        S.missClicks++;
        S.combo = 0;
        popup(x, y, "\u00d7", true);
        AudioFX.miss();
        updateHUD();
    }

    // ---------------- priebeh kola

    function setOverlay(id) {
        ["#ov-menu", "#ov-count", "#ov-pause", "#ov-over"]
            .forEach((s) => $(s).classList.toggle("hidden", s !== id));
    }

    function startRound() {
        if (S.state === "countdown" || S.state === "playing") return;

        S.score = 0;
        S.combo = 0;
        S.hits = 0;
        S.missClicks = 0;
        S.escaped = 0;
        S.bombs = 0;
        S.reactions = [];
        S.timeLeft = S.roundLen;

        clearMoles();
        popupsLayer.innerHTML = "";
        updateHUD();

        setHeader(false);
        setState("countdown");
        setOverlay("#ov-count");

        const num = $("#count-num");
        const seq = ["3", "2", "1", "GO!"];
        let i = 0;
        const step = () => {
            num.textContent = seq[i];
            num.style.animation = "none";
            void num.offsetWidth;
            num.style.animation = "";
            AudioFX.count(seq[i] === "GO!");
            i++;
            if (i < seq.length) {
                countTimer = setTimeout(step, 620);
            } else {
                countTimer = setTimeout(() => {
                    setState("playing");
                    setOverlay(null);
                    lastTick = performance.now();
                    tickTimer = setInterval(tick, 100);
                    scheduleSpawn();
                }, 500);
            }
        };
        step();
    }

    function pauseRound() {
        if (S.state !== "playing") return;
        setState("paused");
        clearTimeout(spawnTimer);
        clearInterval(tickTimer);
        clearMoles();
        setOverlay("#ov-pause");
        setHeader(true);
    }

    function resumeRound() {
        if (S.state !== "paused") return;
        setState("playing");
        setOverlay(null);
        setHeader(false);
        lastTick = performance.now();
        tickTimer = setInterval(tick, 100);
        scheduleSpawn();
    }

    function endRound() {
        if (S.state === "over") return;
        setState("over");
        clearTimeout(spawnTimer);
        clearInterval(tickTimer);
        clearTimeout(countTimer);
        clearMoles();

        const prevBest = bestScore();
        const isBest = S.score > prevBest && S.score > 0;
        saveScore({
            score: S.score,
            hits: S.hits,
            escaped: S.escaped,
            acc: S.hits + S.missClicks
                ? Math.round((100 * S.hits) / (S.hits + S.missClicks))
                : 0,
            react: S.reactions.length
                ? Math.round(S.reactions.reduce((a, b) => a + b, 0) / S.reactions.length)
                : 0,
            ts: Date.now(),
        });

        $("#res-score").textContent = S.score;
        $("#res-hits").textContent = S.hits;
        $("#res-escaped").textContent = S.escaped;
        $("#res-acc").textContent =
            (S.hits + S.missClicks
                ? Math.round((100 * S.hits) / (S.hits + S.missClicks))
                : 0) + "%";
        $("#res-react").textContent =
            (S.reactions.length
                ? S.reactions.reduce((a, b) => a + b, 0) / S.reactions.length / 1000
                : 0).toFixed(2) + " s";
        $("#res-bombs").textContent = S.bombs;
        $("#new-best").classList.toggle("hidden", !isBest);

        updateHUD();
        setOverlay("#ov-over");
        setHeader(true);
        AudioFX.over();
        if (isBest) setTimeout(() => AudioFX.newBest(), 500);
    }

    // ---------------- udalosti

    field.addEventListener("pointerdown", onPointerDown);

    $("#btn-start").addEventListener("click", () => {
        AudioFX.count(false);
        startRound();
    });
    $("#btn-again").addEventListener("click", startRound);
    $("#btn-resume").addEventListener("click", resumeRound);
    $("#btn-quit").addEventListener("click", () => {
        setState("menu");
        setOverlay("#ov-menu");
        setHeader(true);
    });

    $("#btn-sound").addEventListener("click", (e) => {
        const muted = AudioFX.toggle();
        e.currentTarget.textContent = muted ? "ZVUK: VYP" : "ZVUK: ZAP";
    });

    document.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
            if (S.state === "menu" || S.state === "over") {
                e.preventDefault();
                startRound();
            }
        } else if (e.key === "p" || e.key === "P" || e.key === "Escape") {
            if (S.state === "playing") {
                e.preventDefault();
                pauseRound();
            } else if (S.state === "paused") {
                e.preventDefault();
                resumeRound();
            }
        }
    });

    document.addEventListener("visibilitychange", () => {
        if (document.hidden && S.state === "playing") pauseRound();
    });

    // ---------------- init

    buildField();
    updateHUD();
    setHeader(true);
})();
