const canvas = document.getElementById('gameCanvas');
const ctx = canvas.getContext('2d');

const V_WIDTH = 640;
const V_HEIGHT = 480;
const FONT_FAMILY = '"Determination", monospace';

// Folder layout (all URLs are relative to index.html, which sits in the project root):
//   GAME/ASSETS/  base game assets (party sprite sheets, fonts, background.gif, ...)
//   MOD/          encounter.ini + ENEMY/ (enemy sprites) + ATTACKS/ (attack gifs / strip pngs) + BG/ (optional backgrounds)
const ASSET_BASE = 'GAME/ASSETS/';
const DEFAULT_BG_PATH = ASSET_BASE + 'background.gif';
const MOD_BASE = 'MOD/';
const MOD_SUBDIRS = { enemy: 'ENEMY/', attack: 'ATTACKS/', bg: 'BG/', audio: 'AUDIO/' };

const STATES = {
    ACTION_SELECT:  'ACTION_SELECT',
    SUB_MENU:       'SUB_MENU',
    EXECUTE_TURNS:  'EXECUTE_TURNS',
    ATTACK_BAR:     'ATTACK_BAR',
    ENEMY_DIALOGUE: 'ENEMY_DIALOGUE',
    ENEMY_TURN:     'ENEMY_TURN',
    VICTORY:        'VICTORY',
    GAME_OVER:      'GAME_OVER'
};

// Kris is the only one who can ACT. Susie and Ralsei get MAGIC instead.
const ACTIONS_BY_MEMBER = {
    kris:   ['FIGHT', 'ACT',   'ITEM', 'SPARE', 'DEFEND'],
    susie:  ['FIGHT', 'MAGIC', 'ITEM', 'SPARE', 'DEFEND'],
    ralsei: ['FIGHT', 'MAGIC', 'ITEM', 'SPARE', 'DEFEND']
};
const ACTION_ICONS = { FIGHT: 'F', ACT: 'A', MAGIC: 'M', ITEM: 'I', SPARE: 'S', DEFEND: 'D' };

// kind: damage | pacify | heal | mercy. 'mercy' spells are the S/R-Action "standard ACTs".
const SPELLS = {
    kris:   [],
    susie:  [
        { name: 'Rude Buster', cost: 50, target: 'enemy', kind: 'damage' },
        { name: 'S-Action',    cost: 0,  target: 'enemy', kind: 'mercy'  }
    ],
    ralsei: [
        { name: 'Pacify',      cost: 16, target: 'enemy', kind: 'pacify' },
        { name: 'Heal Prayer', cost: 32, target: 'party', kind: 'heal'   },
        { name: 'R-Action',    cost: 0,  target: 'enemy', kind: 'mercy'  }
    ]
};

// Command order: 1 immediate (DEFEND), 2 ACT, 3 MAGIC/SPARE/ITEM, 4 FIGHT
const PHASE = { DEFEND: 1, ACT: 2, MAGIC: 3, SPARE: 3, ITEM: 3, FIGHT: 4 };

// ============================================================================
// MOD ASSET REGISTRY & PURE-JS GIF DECODER
// ============================================================================
const modFiles = new Map(); // normalized relative path -> File object (from folder drop/picker)
const assetCache = new Map(); // path -> { type: 'frames', frames: [{canvas, delayMs}], w, h }

function normalizeModPath(p) {
    return p.replace(/\\/g, '/').replace(/^\.\//, '').toLowerCase();
}

function registerModFileList(fileList) {
    modFiles.clear();
    assetCache.clear();
    audioCache.clear();
    stopMusic();
    let iniFile = null;

    for (const file of fileList) {
        const rel = file.webkitRelativePath || file.name;
        const parts = rel.split('/');
        // Strip top-level folder name if a directory was dropped/selected
        const stripped = parts.length > 1 ? parts.slice(1).join('/') : parts[0];
        const norm = normalizeModPath(stripped);
        modFiles.set(norm, file);
        // Also index by basename as a convenient fallback
        const base = normalizeModPath(parts[parts.length - 1]);
        if (!modFiles.has(base)) modFiles.set(base, file);

        if (base === 'encounter.ini' || base === 'encounter.txt' || (!iniFile && (base.endsWith('.ini') || base.endsWith('.txt')))) {
            iniFile = file;
        }
    }
    return iniFile;
}

function findModFile(path) {
    const norm = normalizeModPath(path);
    return modFiles.get(norm) || modFiles.get(norm.split('/').pop()) || null;
}

function isAbsoluteUrl(p) {
    return /^(https?:|data:|blob:|\/)/i.test(p);
}

// URLs to try when a mod asset is fetched over HTTP, most specific first.
// "ENEMY/boss.png" -> MOD/ENEMY/boss.png. A bare "boss.png" also tries MOD/ENEMY/boss.png
// (or MOD/ATTACKS/ for attacks, MOD/BG/ for backgrounds) so mods can skip the folder name.
function modUrlCandidates(path, kind) {
    if (isAbsoluteUrl(path)) return [path];
    const clean = path.replace(/\\/g, '/').replace(/^\.\//, '');
    const list = [MOD_BASE + clean];
    const sub = MOD_SUBDIRS[kind];
    if (sub && !clean.toUpperCase().startsWith(sub)) list.push(MOD_BASE + sub + clean);
    return list;
}

async function fetchModBuffer(path, kind = 'attack') {
    const localFile = findModFile(path);
    if (localFile) return await localFile.arrayBuffer();

    let lastErr = null;
    for (const url of modUrlCandidates(path, kind)) {
        try {
            const res = await fetch(url);
            if (res.ok) return await res.arrayBuffer();
            lastErr = new Error(`HTTP ${res.status} loading ${url}`);
        } catch (err) {
            lastErr = err;
        }
    }
    throw lastErr || new Error(`Could not load ${path}`);
}

function loadImageUrl(url) {
    return new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = () => reject(new Error(`Failed to load image: ${url}`));
        img.src = url;
    });
}

async function fetchModImage(path, kind = 'attack') {
    const localFile = findModFile(path);
    if (localFile) return await loadImageUrl(URL.createObjectURL(localFile));

    let lastErr = null;
    for (const url of modUrlCandidates(path, kind)) {
        try {
            return await loadImageUrl(url);
        } catch (err) {
            lastErr = err;
        }
    }
    throw lastErr || new Error(`Failed to load image: ${path}`);
}

// Pure-JS GIF87a/89a LZW Decoder -> returns [{ canvas, delayMs }]
function decodeGifBuffer(buffer) {
    const bytes = new Uint8Array(buffer);
    let pos = 0;
    const readByte = () => bytes[pos++];
    const readU16 = () => { const v = bytes[pos] | (bytes[pos + 1] << 8); pos += 2; return v; };
    const readSubBlocks = () => {
        const chunks = [];
        let total = 0, len;
        while ((len = readByte()) > 0) {
            chunks.push(bytes.subarray(pos, pos + len));
            pos += len;
            total += len;
        }
        const out = new Uint8Array(total);
        let offset = 0;
        for (const c of chunks) { out.set(c, offset); offset += c.length; }
        return out;
    };
    const readColorTable = (count) => {
        const table = new Uint8Array(count * 3);
        table.set(bytes.subarray(pos, pos + count * 3));
        pos += count * 3;
        return table;
    };

    const header = String.fromCharCode(...bytes.subarray(0, 6));
    if (header !== 'GIF87a' && header !== 'GIF89a') throw new Error('Invalid GIF header');
    pos = 6;

    const width = readU16();
    const height = readU16();
    const lsdPacked = readByte();
    pos += 2; // bgColorIndex, pixelAspect

    const gct = (lsdPacked & 0x80) ? readColorTable(1 << ((lsdPacked & 0x07) + 1)) : null;

    const masterCanvas = document.createElement('canvas');
    masterCanvas.width = width;
    masterCanvas.height = height;
    const masterCtx = masterCanvas.getContext('2d', { willReadFrequently: true });
    const masterImg = masterCtx.createImageData(width, height);

    const frames = [];
    let gce = { delay: 6, disposal: 0, hasTrans: false, transIndex: 0 };

    while (pos < bytes.length) {
        const blockType = readByte();
        if (blockType === 0x3B) break; // Trailer

        if (blockType === 0x21) { // Extension
            const label = readByte();
            if (label === 0xF9) { // Graphic Control Extension
                readByte(); // block size (4)
                const packed = readByte();
                gce.disposal = (packed >> 2) & 0x07;
                gce.hasTrans = (packed & 0x01) !== 0;
                gce.delay = readU16();
                gce.transIndex = readByte();
                readByte(); // terminator
            } else {
                let len;
                while ((len = readByte()) > 0) pos += len;
            }
            continue;
        }

        if (blockType === 0x2C) { // Image Descriptor
            const left = readU16();
            const top = readU16();
            const w = readU16();
            const h = readU16();
            const packed = readByte();
            const hasLct = (packed & 0x80) !== 0;
            const interlaced = (packed & 0x40) !== 0;
            const ct = hasLct ? readColorTable(1 << ((packed & 0x07) + 1)) : gct;

            const minCodeSize = readByte();
            const lzwData = readSubBlocks();
            const indexed = lzwDecode(minCodeSize, lzwData, w * h);

            const prevSnapshot = gce.disposal === 3 ? new Uint8ClampedArray(masterImg.data) : null;

            // De-interlace row mapping if needed
            const rowMap = new Int32Array(h);
            if (!interlaced) {
                for (let y = 0; y < h; y++) rowMap[y] = y;
            } else {
                let srcY = 0;
                for (const [start, step] of [[0, 8], [4, 8], [2, 4], [1, 2]]) {
                    for (let y = start; y < h; y += step) rowMap[srcY++] = y;
                }
            }

            const md = masterImg.data;
            for (let y = 0; y < h; y++) {
                const dy = top + rowMap[y];
                if (dy < 0 || dy >= height) continue;
                for (let x = 0; x < w; x++) {
                    const dx = left + x;
                    if (dx < 0 || dx >= width) continue;
                    const idx = indexed[y * w + x];
                    if (gce.hasTrans && idx === gce.transIndex) continue;
                    const dst = (dy * width + dx) * 4;
                    const src = idx * 3;
                    md[dst]     = ct[src];
                    md[dst + 1] = ct[src + 1];
                    md[dst + 2] = ct[src + 2];
                    md[dst + 3] = 255;
                }
            }

            masterCtx.putImageData(masterImg, 0, 0);
            const frameCanvas = document.createElement('canvas');
            frameCanvas.width = width;
            frameCanvas.height = height;
            frameCanvas.getContext('2d').drawImage(masterCanvas, 0, 0);

            frames.push({
                canvas: frameCanvas,
                delayMs: Math.max(20, (gce.delay || 6) * 10)
            });

            // Disposal
            if (gce.disposal === 2) {
                for (let y = 0; y < h; y++) {
                    const dy = top + y;
                    if (dy < 0 || dy >= height) continue;
                    for (let x = 0; x < w; x++) {
                        const dx = left + x;
                        if (dx < 0 || dx >= width) continue;
                        const dst = (dy * width + dx) * 4;
                        md[dst] = md[dst + 1] = md[dst + 2] = md[dst + 3] = 0;
                    }
                }
            } else if (gce.disposal === 3 && prevSnapshot) {
                masterImg.data.set(prevSnapshot);
            }

            gce = { delay: 6, disposal: 0, hasTrans: false, transIndex: 0 };
        }
    }
    return { frames, w: width, h: height };
}

function lzwDecode(minCodeSize, data, pixelCount) {
    const clearCode = 1 << minCodeSize;
    const endCode = clearCode + 1;
    let codeSize = minCodeSize + 1;
    let nextCode = endCode + 1;

    const prefix = new Int32Array(4096);
    const suffix = new Uint8Array(4096);
    const stack = new Uint8Array(4096);

    for (let i = 0; i < clearCode; i++) {
        prefix[i] = -1;
        suffix[i] = i;
    }

    const out = new Uint8Array(pixelCount);
    let outPos = 0, bitBuf = 0, bitCount = 0, bytePos = 0;
    let prevCode = -1, firstChar = 0;

    const readCode = () => {
        while (bitCount < codeSize && bytePos < data.length) {
            bitBuf |= data[bytePos++] << bitCount;
            bitCount += 8;
        }
        if (bitCount < codeSize) return endCode;
        const code = bitBuf & ((1 << codeSize) - 1);
        bitBuf >>= codeSize;
        bitCount -= codeSize;
        return code;
    };

    while (outPos < pixelCount) {
        const code = readCode();
        if (code === clearCode) {
            codeSize = minCodeSize + 1;
            nextCode = endCode + 1;
            prevCode = -1;
            continue;
        }
        if (code === endCode) break;

        let cur = code, stackTop = 0;
        if (cur >= nextCode) {
            stack[stackTop++] = firstChar;
            cur = prevCode;
        }
        while (cur >= clearCode && stackTop < 4096) {
            stack[stackTop++] = suffix[cur];
            cur = prefix[cur];
        }
        firstChar = suffix[cur];
        stack[stackTop++] = firstChar;

        while (stackTop > 0 && outPos < pixelCount) {
            out[outPos++] = stack[--stackTop];
        }

        if (prevCode !== -1 && nextCode < 4096) {
            prefix[nextCode] = prevCode;
            suffix[nextCode] = firstChar;
            nextCode++;
            if (nextCode >= (1 << codeSize) && codeSize < 12) codeSize++;
        }
        prevCode = code;
    }
    return out;
}

// Loads a .gif (all frames), a _stripN.png, or a single image into uniform frame canvases
async function loadAnimatedAsset(path, stripCountHint = 0, kind = 'attack') {
    if (!path) return null;
    const key = `${kind}|${normalizeModPath(path)}|${stripCountHint}`;
    if (assetCache.has(key)) return assetCache.get(key);

    const promise = (async () => {
        try {
            if (path.toLowerCase().endsWith('.gif')) {
                const buf = await fetchModBuffer(path, kind);
                return decodeGifBuffer(buf);
            }
            const img = await fetchModImage(path, kind);
            const stripMatch = path.match(/_strip(\d+)\.[^.]+$/i);
            const count = stripCountHint || (stripMatch ? parseInt(stripMatch[1], 10) : 1);
            const fw = Math.floor(img.naturalWidth / Math.max(1, count));
            const fh = img.naturalHeight;
            const frames = [];
            for (let i = 0; i < count; i++) {
                const fc = document.createElement('canvas');
                fc.width = fw;
                fc.height = fh;
                fc.getContext('2d').drawImage(img, i * fw, 0, fw, fh, 0, 0, fw, fh);
                frames.push({ canvas: fc, delayMs: 80 });
            }
            return { frames, w: fw, h: fh };
        } catch (err) {
            console.warn('Could not load mod asset:', path, err.message);
            return null;
        }
    })();

    assetCache.set(key, promise);
    return promise;
}

// ============================================================================
// BATTLE BACKGROUND LOADER (MOD GIF/PNG WITH FALLBACK TO GAME/ASSETS/background.gif)
// ============================================================================
let defaultBgAsset = null;
let activeBg = null; // { asset, frameIdx, frameTimerMs, fps }

async function loadDefaultBackground() {
    if (defaultBgAsset) return defaultBgAsset;
    try {
        const res = await fetch(DEFAULT_BG_PATH);
        if (res.ok) {
            const buf = await res.arrayBuffer();
            defaultBgAsset = decodeGifBuffer(buf);
            return defaultBgAsset;
        }
    } catch (_) {
        // Fallback for file:// where fetch() may be blocked by browser CORS
    }
    try {
        const img = await loadImageUrl(DEFAULT_BG_PATH);
        defaultBgAsset = {
            frames: [{ canvas: img, delayMs: 80 }],
            w: img.naturalWidth,
            h: img.naturalHeight
        };
    } catch (err) {
        console.warn('Could not load default background:', DEFAULT_BG_PATH, err.message);
    }
    return defaultBgAsset;
}

async function setBattleBackground(path = null, fps = null) {
    const epoch = battleEpoch;
    const fallback = await loadDefaultBackground();
    if (epoch !== battleEpoch) return;

    // Immediately show default background so there is no blank frame while a mod background loads
    if (!activeBg && fallback) {
        activeBg = { asset: fallback, frameIdx: 0, frameTimerMs: 0, fps: null };
    }

    if (path && typeof path === 'string') {
        const modAsset = await loadAnimatedAsset(path, 0, 'bg');
        if (epoch !== battleEpoch) return;
        if (modAsset && modAsset.frames.length > 0) {
            activeBg = { asset: modAsset, frameIdx: 0, frameTimerMs: 0, fps: fps || null };
            return;
        }
    }

    if (fallback) {
        activeBg = { asset: fallback, frameIdx: 0, frameTimerMs: 0, fps: fps || null };
    } else {
        activeBg = null;
    }
}

function updateBackground() {
    if (!activeBg || !activeBg.asset || activeBg.asset.frames.length <= 1) return;
    const frames = activeBg.asset.frames;
    const curFrame = frames[activeBg.frameIdx % frames.length];
    const frameDuration = activeBg.fps ? (1000 / activeBg.fps) : curFrame.delayMs;

    activeBg.frameTimerMs += STEP_MS;
    while (activeBg.frameTimerMs >= frameDuration) {
        activeBg.frameTimerMs -= frameDuration;
        activeBg.frameIdx = (activeBg.frameIdx + 1) % frames.length;
    }
}

function drawBackground() {
    if (!activeBg || !activeBg.asset || activeBg.asset.frames.length === 0) return;
    const frames = activeBg.asset.frames;
    const fc = frames[activeBg.frameIdx % frames.length].canvas;
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(fc, 0, 0, V_WIDTH, V_HEIGHT);
}

// ============================================================================
// AUDIO: MUSIC, SOUND EFFECTS & ATTACK WARNINGS
// ============================================================================
// Each sound is picked in this order:
//   1. the mod's file from the [AUDIO] section of its INI
//   2. the base game file GAME/ASSETS/<sound name>.wav, .ogg or .mp3
//   3. the built-in synthesized version
const BASE_AUDIO_EXTENSIONS = ['wav', 'ogg', 'mp3'];

// Each tone: [start s, length s, start Hz, end Hz, wave, volume]
const SFX_SYNTH = {
    menu_move:    [[0, .045, 880, 880, 'square', .22]],
    menu_select:  [[0, .05, 660, 660, 'square', .25], [.05, .08, 990, 990, 'square', .25]],
    menu_back:    [[0, .05, 520, 520, 'square', .22], [.05, .07, 350, 350, 'square', .22]],
    menu_denied:  [[0, .07, 160, 160, 'square', .3], [.09, .1, 130, 130, 'square', .3]],
    text:         [[0, .025, 440, 440, 'square', .1]],
    attack:       [[0, .12, 900, 180, 'saw', .35], [0, .09, 0, 0, 'noise', .25]],
    attack_critical: [[0, .12, 1200, 250, 'saw', .35], [0, .1, 0, 0, 'noise', .25], [.08, .22, 1568, 2093, 'square', .22]],
    attack_miss:  [[0, .14, 300, 120, 'triangle', .3]],
    enemy_hit:    [[0, .14, 220, 60, 'square', .3], [0, .1, 0, 0, 'noise', .3]],
    magic:        [[0, .35, 250, 1400, 'saw', .22], [.05, .3, 500, 1800, 'triangle', .25]],
    heal:         [[0, .1, 523, 523, 'triangle', .4], [.08, .1, 659, 659, 'triangle', .4], [.16, .22, 1047, 1047, 'triangle', .4]],
    item:         [[0, .08, 392, 392, 'square', .22], [.08, .16, 784, 784, 'square', .22]],
    act:          [[0, .07, 587, 587, 'triangle', .35], [.07, .12, 880, 880, 'triangle', .35]],
    spare:        [[0, .3, 700, 1760, 'triangle', .35], [.1, .3, 1047, 2637, 'triangle', .2]],
    defend:       [[0, .18, 200, 400, 'square', .25]],
    hurt:         [[0, .22, 260, 70, 'square', .4], [0, .15, 0, 0, 'noise', .35]],
    down:         [[0, .5, 330, 55, 'saw', .35]],
    graze:        [[0, .04, 1800, 2200, 'triangle', .18]],
    warning:      [[0, .09, 1245, 1245, 'square', .35], [.13, .09, 1245, 1245, 'square', .35]],
    attack_start: [[0, .16, 130, 390, 'saw', .25]],
    phase:        [[0, .6, 90, 360, 'saw', .35], [0, .5, 0, 0, 'noise', .15]],
    victory:      [[0, .14, 523, 523, 'square', .25], [.14, .14, 659, 659, 'square', .25], [.28, .14, 784, 784, 'square', .25], [.42, .5, 1047, 1047, 'square', .25]],
    gameover:     [[0, .35, 392, 392, 'triangle', .45], [.35, .35, 311, 311, 'triangle', .45], [.7, .9, 196, 185, 'triangle', .45]]
};

const SYNTH_RATE = 22050;
const WAVES = {
    square:   t => (t % 1 < 0.5 ? 1 : -1) * 0.6,
    saw:      t => ((t % 1) * 2 - 1) * 0.7,
    triangle: t => 1 - 4 * Math.abs((t % 1) - 0.5),
    noise:    () => Math.random() * 2 - 1
};

const audioPrefs = { muted: false };
try { audioPrefs.muted = localStorage.getItem('battleMuted') === '1'; } catch (_) {}

let audioCtx = null, masterGain = null, musicGain = null, sfxGain = null;
const audioCache = new Map(); // mod path -> Promise<AudioBuffer|null>
const synthCache = new Map(); // sound name -> AudioBuffer
const sfxOverrides = new Map(); // sound name -> AudioBuffer | 'none'
const baseCache = new Map(); // sound name -> Promise<AudioBuffer|null>
const baseSfx = new Map(); // sound name -> AudioBuffer from GAME/ASSETS
let musicSource = null, musicKey = null, musicToken = 0;
let muteNoticeFrames = 0;

function getAudioContext() {
    if (audioCtx) return audioCtx;
    const Ctor = window.AudioContext || window.webkitAudioContext;
    if (!Ctor) return null;
    audioCtx = new Ctor();
    masterGain = audioCtx.createGain();
    musicGain = audioCtx.createGain();
    sfxGain = audioCtx.createGain();
    masterGain.gain.value = audioPrefs.muted ? 0 : 1;
    musicGain.connect(masterGain);
    sfxGain.connect(masterGain);
    masterGain.connect(audioCtx.destination);
    return audioCtx;
}

// Browsers keep audio locked until the first key press, click or tap.
function unlockAudio() {
    const ac = getAudioContext();
    if (ac && ac.state !== 'running' && !document.hidden) ac.resume().catch(() => {});
}
['keydown', 'pointerdown', 'pointerup', 'touchend'].forEach(type =>
    window.addEventListener(type, e => { if (e.isTrusted) unlockAudio(); }, true));
document.addEventListener('visibilitychange', () => {
    if (!audioCtx) return;
    (document.hidden ? audioCtx.suspend() : audioCtx.resume()).catch(() => {});
});

function toggleMute() {
    audioPrefs.muted = !audioPrefs.muted;
    if (masterGain) masterGain.gain.value = audioPrefs.muted ? 0 : 1;
    try { localStorage.setItem('battleMuted', audioPrefs.muted ? '1' : '0'); } catch (_) {}
    muteNoticeFrames = 90;
}

function renderTones(tones) {
    const length = Math.max(...tones.map(t => t[0] + t[1]));
    const buffer = audioCtx.createBuffer(1, Math.ceil(length * SYNTH_RATE), SYNTH_RATE);
    const out = buffer.getChannelData(0);
    for (const [start, dur, f0, f1, wave, vol] of tones) {
        const first = Math.floor(start * SYNTH_RATE), count = Math.floor(dur * SYNTH_RATE);
        let phase = 0;
        for (let i = 0; i < count && first + i < out.length; i++) {
            const k = i / count;
            phase += (f0 + (f1 - f0) * k) / SYNTH_RATE;
            const envelope = Math.min(1, i / 60) * Math.min(1, (1 - k) * 3);
            out[first + i] += WAVES[wave](phase) * vol * envelope;
        }
    }
    return buffer;
}

// Original 8-bar loop used when the INI has no music file
function builtInMusicTones() {
    const hz = n => 440 * Math.pow(2, (n - 69) / 12);
    const beat = 60 / 140, tones = [];
    const roots = [45, 45, 41, 43, 45, 45, 41, 40];
    const lead = [
        [69, 0, 72, 76, 0, 74, 72, 0], [69, 0, 72, 76, 79, 0, 76, 0],
        [77, 0, 76, 72, 0, 69, 72, 0], [74, 0, 71, 74, 79, 0, 74, 0],
        [81, 0, 79, 76, 0, 74, 76, 0], [72, 74, 76, 0, 69, 0, 72, 0],
        [77, 0, 81, 77, 0, 76, 72, 0], [76, 0, 71, 0, 68, 0, 71, 0]
    ];
    roots.forEach((root, bar) => {
        for (let step = 0; step < 8; step++) {
            const t = (bar * 4 + step / 2) * beat;
            const bass = hz(root + (step % 2 ? 12 : 0));
            tones.push([t, beat * 0.42, bass, bass, 'triangle', 0.4]);
            if (lead[bar][step]) {
                const f = hz(lead[bar][step]);
                tones.push([t, beat * 0.45, f, f, 'square', 0.12]);
            }
            if (step % 2 === 0) tones.push([t, 0.09, 150, 40, 'triangle', 0.5]);
            else tones.push([t, 0.04, 0, 0, 'noise', 0.08]);
        }
    });
    // silent tail marker keeps the loop exactly 8 bars long
    tones.push([32 * beat - 0.001, 0.001, 0, 0, 'triangle', 0]);
    return tones;
}

function loadModAudio(path) {
    const key = normalizeModPath(path);
    if (!audioCache.has(key)) {
        audioCache.set(key, (async () => {
            try {
                const bytes = await fetchModBuffer(path, 'audio');
                return await decodeAudio(bytes);
            } catch (err) {
                console.warn('Could not load audio:', path, (err && err.message) || err);
                return null;
            }
        })());
    }
    return audioCache.get(key);
}

function decodeAudio(bytes) {
    return new Promise((res, rej) => audioCtx.decodeAudioData(bytes, res, rej));
}

function loadBaseAudio(name) {
    if (!baseCache.has(name)) {
        baseCache.set(name, (async () => {
            for (const ext of BASE_AUDIO_EXTENSIONS) {
                const url = `${ASSET_BASE}${name}.${ext}`;
                try {
                    const res = await fetch(url);
                    if (!res.ok) continue;
                    const buffer = await decodeAudio(await res.arrayBuffer());
                    baseSfx.set(name, buffer);
                    return buffer;
                } catch (err) {
                    console.warn('Could not load base audio:', url, (err && err.message) || err);
                }
            }
            return null;
        })());
    }
    return baseCache.get(name);
}

function getSynth(name) {
    if (!synthCache.has(name)) {
        synthCache.set(name, renderTones(name === 'music' ? builtInMusicTones() : SFX_SYNTH[name]));
    }
    return synthCache.get(name);
}

function playBuffer(buffer) {
    const src = audioCtx.createBufferSource();
    src.buffer = buffer;
    src.connect(sfxGain);
    src.start();
}

function playSfx(name) {
    // Skipped while locked, otherwise queued sounds would all burst out on unlock
    if (!audioCtx || audioCtx.state !== 'running') return;
    const override = sfxOverrides.get(name);
    if (override === 'none') return;
    const buffer = override || baseSfx.get(name) || (SFX_SYNTH[name] && getSynth(name));
    if (buffer) playBuffer(buffer);
}

// One-off sound given by file path (per-attack "sound = ..." setting)
async function playFileSfx(path) {
    if (!getAudioContext() || isNone(path)) return;
    const epoch = battleEpoch;
    const buffer = await loadModAudio(String(path));
    if (buffer && epoch === battleEpoch && audioCtx.state === 'running') playBuffer(buffer);
}

const isNone = v => ['none', 'off', 'false'].includes(String(v).toLowerCase());

function stopMusic() {
    musicToken++;
    musicKey = null;
    if (musicSource) {
        musicSource.stop();
        musicSource.disconnect();
        musicSource = null;
    }
}

// path: a file in MOD/AUDIO/, empty for the base game music, or "none" for silence
async function playMusic(path, restart = false) {
    if (!getAudioContext()) return;
    const key = path ? String(path) : 'builtin';
    if (!restart && key === musicKey) return;
    stopMusic();
    musicKey = key;
    const token = musicToken;
    if (isNone(key)) return;
    let buffer = key === 'builtin' ? null : await loadModAudio(key);
    if (token !== musicToken) return; // another track was requested while loading
    if (!buffer) buffer = await loadBaseAudio('music');
    if (token !== musicToken) return;
    if (!buffer) buffer = getSynth('music');
    musicSource = audioCtx.createBufferSource();
    musicSource.buffer = buffer;
    musicSource.loop = true;
    musicSource.connect(musicGain);
    musicSource.start();
}

// Reads [AUDIO] for the current mod and preloads its files
function setupBattleAudio(mod, music) {
    if (!getAudioContext()) return;
    const cfg = (mod && mod.audio) || {};
    const volume = (v, fallback) => Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : fallback;
    musicGain.gain.value = volume(cfg.musicvolume, 0.45);
    sfxGain.gain.value = volume(cfg.sfxvolume, 0.7);

    sfxOverrides.clear();
    const epoch = battleEpoch;
    Object.keys(SFX_SYNTH).forEach(name => {
        loadBaseAudio(name);
        const value = cfg[name];
        if (value === undefined || value === '') return;
        if (isNone(value)) { sfxOverrides.set(name, 'none'); return; }
        loadModAudio(String(value)).then(buffer => {
            if (buffer && epoch === battleEpoch) sfxOverrides.set(name, buffer);
        });
    });
    if (mod) {
        mod.phases.forEach(p => { if (p.music && !isNone(p.music)) loadModAudio(String(p.music)); });
        Object.values(mod.attackMeta).forEach(m => { if (m.sound && !isNone(m.sound)) loadModAudio(String(m.sound)); });
    }
    playMusic(music, true);
}

// --- Red (#FF0000) warning pixels -------------------------------------------
function frameHasWarning(frame) {
    if (frame.hasWarning === undefined) {
        const { width, height } = frame.canvas;
        const data = frame.canvas.getContext('2d').getImageData(0, 0, width, height).data;
        frame.hasWarning = false;
        for (let i = 0; i < data.length; i += 4) {
            if (data[i] === 255 && data[i + 1] === 0 && data[i + 2] === 0 && data[i + 3] >= 128) {
                frame.hasWarning = true;
                break;
            }
        }
    }
    return frame.hasWarning;
}

// Plays when red appears; red held across several frames only warns once
function updateAttackWarning() {
    const a = activeAttack;
    if (!a || !a.asset || !a.warn) return;
    const red = frameHasWarning(a.asset.frames[a.frameIdx % a.asset.frames.length]);
    if (red && !a.redShowing) playSfx('warning');
    a.redShowing = red;
}

// ============================================================================
// INI / TXT ENCOUNTER PARSER
// ============================================================================
function parseScalar(val) {
    if (val === 'true') return true;
    if (val === 'false') return false;
    const num = Number(val);
    return (val !== '' && !Number.isNaN(num)) ? num : val;
}

function parseEncounterIni(rawText) {
    const cfg = {
        arena: { w: 180, h: 150 },
        party: {},
        enemies: [],
        acts: {},
        audio: {},
        phases: [],
        attacks: { turns: {}, loop: 'last', maxTurn: 0 },
        attackMeta: {},
        background: null,
        victoryText: null,
        gameOverText: null
    };

    let sectionType = 'BATTLE';
    let sectionName = null;
    let currentObj = cfg;

    for (const rawLine of rawText.split(/\r?\n/)) {
        const line = rawLine.trim();
        if (!line || line.startsWith('#') || line.startsWith(';')) continue;

        if (line.startsWith('[') && line.endsWith(']')) {
            const header = line.slice(1, -1).trim();
            const upper = header.toUpperCase();

            if (upper === 'AUDIO' || upper === 'SOUND') {
                sectionType = 'AUDIO';
                currentObj = cfg.audio;
            } else if (upper === 'ARENA') {
                sectionType = 'ARENA';
                currentObj = cfg.arena;
            } else if (upper === 'BATTLE' || upper === 'BACKGROUND' || upper === 'BG') {
                sectionType = 'BATTLE';
                currentObj = cfg;
            } else if (upper.startsWith('PARTY_')) {
                sectionType = 'PARTY';
                sectionName = header.slice(6).toLowerCase();
                cfg.party[sectionName] = cfg.party[sectionName] || {};
                currentObj = cfg.party[sectionName];
            } else if (upper === 'ENEMY' || upper === 'BOSS') {
                sectionType = 'ENEMY';
                currentObj = {
                    name: 'Enemy', hp: 100, def: 0, x: 470, y: 80, scale: 2,
                    sprite: null, frameW: 0, frameH: 0, fps: 8,
                    anims: {}, flavor: ['* An enemy draws near!'], _defaultFlavor: true,
                    acts: ['Check', 'Flatter'], canTire: true
                };
                cfg.enemies.push(currentObj);
            } else if (upper.startsWith('ENEMY_ANIM:') || upper.startsWith('BOSS_ANIM:')) {
                sectionType = 'ENEMY_ANIM';
                sectionName = header.split(':')[1].trim();
                const targetEnemy = cfg.enemies[cfg.enemies.length - 1];
                currentObj = { frames: '0', ticks: 8, loop: true };
                if (targetEnemy) targetEnemy.anims[sectionName] = currentObj;
            } else if (upper.startsWith('ACT:')) {
                sectionType = 'ACT';
                sectionName = header.slice(4).trim();
                currentObj = { name: sectionName, mercy: 50, tired: false, text: '' };
                cfg.acts[sectionName.toLowerCase()] = currentObj;
            } else if (upper.startsWith('PHASE_') && upper.endsWith('_ATTACKS')) {
                sectionType = 'PHASE_ATTACKS';
                const pNum = parseInt(header.slice(6), 10);
                let phase = cfg.phases.find(p => p.num === pNum);
                if (!phase) {
                    phase = { num: pNum, trigger: null, dialogue: '', boss_anim: '', flavor: [], attacks: null };
                    cfg.phases.push(phase);
                }
                phase.attacks = { turns: {}, loop: 'last', maxTurn: 0 };
                currentObj = phase.attacks;
            } else if (upper.startsWith('PHASE_')) {
                sectionType = 'PHASE';
                const pNum = parseInt(header.slice(6), 10);
                let phase = cfg.phases.find(p => p.num === pNum);
                if (!phase) {
                    phase = { num: pNum, trigger: null, dialogue: '', boss_anim: '', flavor: [], attacks: null };
                    cfg.phases.push(phase);
                }
                currentObj = phase;
            } else if (upper === 'ATTACKS') {
                sectionType = 'ATTACKS';
                currentObj = cfg.attacks;
            } else if (upper.startsWith('ATTACK:') || upper.startsWith('GIF:')) {
                sectionType = 'ATTACK_META';
                sectionName = header.slice(header.indexOf(':') + 1).trim();
                currentObj = { file: sectionName };
                cfg.attackMeta[sectionName.toLowerCase()] = currentObj;
            } else {
                sectionType = null;
                currentObj = null;
            }
            continue;
        }

        const eqIdx = line.indexOf('=');
        if (eqIdx === -1 || !currentObj) continue;
        const key = line.slice(0, eqIdx).trim();
        const val = line.slice(eqIdx + 1).trim();
        const keyLower = key.toLowerCase();

        if (sectionType === 'ATTACKS' || sectionType === 'PHASE_ATTACKS') {
            if (keyLower === 'loop') {
                const n = Number(val);
                currentObj.loop = (val.toLowerCase() === 'last' || Number.isNaN(n)) ? 'last' : n;
            } else {
                const turnNum = Number(key);
                if (!Number.isNaN(turnNum)) {
                    const cleaned = val.replace(/^\{|\}$/g, '');
                    currentObj.turns[turnNum] = cleaned.split(',').map(s => s.trim()).filter(Boolean);
                    currentObj.maxTurn = Math.max(currentObj.maxTurn, turnNum);
                }
            }
            continue;
        }

        if (sectionType === 'AUDIO') {
            currentObj[keyLower] = parseScalar(val);
            continue;
        }

        if (sectionType === 'ENEMY' && keyLower === 'acts') {
            currentObj.acts = val.split(',').map(s => s.trim()).filter(Boolean);
            continue;
        }

        if ((sectionType === 'ENEMY' || sectionType === 'PHASE') && keyLower.startsWith('flavor')) {
            if (!Array.isArray(currentObj.flavor) || currentObj._defaultFlavor) {
                currentObj.flavor = [];
                currentObj._defaultFlavor = false;
            }
            currentObj.flavor.push(val);
            continue;
        }

        currentObj[key] = parseScalar(val);
    }

    cfg.phases.sort((a, b) => a.num - b.num);
    return cfg;
}

// --- Sprite sheet loader helper ----------------------------------------------
function loadSheet(candidates, stripBgRgb = null) {
    const state = { img: new Image(), drawable: null, idx: 0 };
    state.drawable = state.img;

    state.img.onload = () => {
        if (!stripBgRgb) {
            state.drawable = state.img;
            return;
        }
        try {
            const off = document.createElement('canvas');
            off.width = state.img.naturalWidth;
            off.height = state.img.naturalHeight;
            const octx = off.getContext('2d');
            octx.drawImage(state.img, 0, 0);
            const imgData = octx.getImageData(0, 0, off.width, off.height);
            const d = imgData.data;
            const [br, bg, bb] = stripBgRgb;
            for (let i = 0; i < d.length; i += 4) {
                if (Math.hypot(d[i] - br, d[i + 1] - bg, d[i + 2] - bb) < 42) {
                    d[i + 3] = 0;
                }
            }
            octx.putImageData(imgData, 0, 0);
            state.drawable = off;
        } catch (_) {
            state.drawable = state.img;
        }
    };

    state.img.onerror = () => {
        state.idx++;
        if (state.idx < candidates.length) {
            state.img.src = candidates[state.idx];
        } else {
            console.error('Could not load sprite sheet. Tried:', candidates.join(', '));
        }
    };

    state.img.src = candidates[0];
    return state;
}

const assets = names => names.map(n => ASSET_BASE + n);

const krisSheet = loadSheet(
    assets(['kris-sheet.jpg', 'kris-sheet.png']),
    [138, 90, 157]
);

const ralseiSheet = loadSheet(
    assets(['rals-sheet.png', 'rals-sheet.jpg', 'ralsei-sheet.png'])
);

const susieSheet = loadSheet(
    assets(['susie-sheet.png', 'susie-sheet_4.png', 'susie-sheet_4.jpg', 'susie-sheet_3.png', 'susie-sheet_3.jpg', 'susie-sheet.jpg'])
);

const SPRITE_SCALE = 2;            // the sheets are native-res; the game draws them at 2x
const PARTY_X = 135;               // x of the party's feet (clear of the TP meter and Susie's axe)
const PARTY_FEET_Y = [98, 182, 266]; // 84px apart: idle sprites are ~76-86px tall, so nobody overlaps

// --- Frame & Animation Definitions -------------------------------------------
const KRIS_FRAMES = {
    idle: [
        [9, 37, 34, 37, 10, 37],
        [49, 37, 35, 37, 11, 37],
        [89, 37, 36, 37, 12, 37],
        [130, 36, 36, 38, 12, 38],
        [171, 36, 36, 38, 12, 38],
        [213, 36, 35, 38, 11, 38]
    ],
    attack: [
        [8, 90, 28, 43, 11, 43],
        [77, 92, 45, 47, 9, 41],
        [144, 92, 45, 47, 10, 41],
        [213, 100, 27, 40, 9, 33],
        [281, 100, 27, 40, 9, 33],
        [349, 100, 24, 39, 9, 33],
        [420, 100, 19, 39, 6, 33],
        [488, 100, 19, 39, 6, 33]
    ],
    prepare: [
        [12, 167, 29, 37, 14, 36],
        [80, 167, 30, 37, 14, 36]
    ],
    hurt: [
        [151, 167, 33, 37, 10, 36]
    ],
    downed: [
        [223, 179, 32, 25, 13, 25]
    ],
    act: [
        [12, 231, 30, 37, 14, 36],
        [80, 231, 41, 37, 14, 36],
        [149, 231, 50, 37, 13, 36],
        [217, 231, 54, 37, 13, 36],
        [285, 231, 56, 37, 13, 36],
        [353, 231, 47, 37, 13, 36],
        [421, 231, 36, 37, 13, 36],
        [489, 231, 36, 37, 13, 36],
        [555, 231, 27, 37, 15, 36],
        [622, 231, 35, 37, 9, 36],
        [689, 231, 34, 37, 10, 36]
    ],
    item: [
        [12, 295, 22, 37, 14, 36],
        [80, 295, 22, 37, 14, 36],
        [149, 295, 32, 37, 13, 36],
        [217, 289, 31, 43, 13, 42],
        [285, 294, 31, 38, 13, 37],
        [353, 292, 31, 40, 13, 39],
        [421, 290, 31, 42, 13, 41],
        [489, 295, 31, 37, 13, 36]
    ],
    defend: [
        [9, 357, 33, 37, 10, 37],
        [47, 354, 31, 40, 12, 40],
        [87, 358, 35, 36, 11, 36],
        [127, 354, 32, 40, 11, 40],
        [169, 358, 31, 36, 9, 36],
        [209, 358, 28, 36, 9, 36]
    ]
};

const KRIS_ANIMS = {
    idle:    { loop: true, ticks: 8 },
    attack:  { ticks: 4 },
    prepare: { ticks: 6 },
    hurt:    { ticks: 30 },
    downed:  { ticks: 1 },
    act:     { ticks: 5 },
    item:    { ticks: 6 },
    defend:  { ticks: 4 }
};

const RALSEI_FRAMES = {
    intro: [
        [7, 12, 19, 40, 12, 39],
        [82, 12, 19, 40, 11, 39],
        [154, 11, 28, 41, 13, 40],
        [227, 12, 40, 40, 14, 39],
        [302, 12, 44, 40, 13, 39],
        [375, 10, 47, 42, 14, 41],
        [449, 9, 46, 43, 14, 42],
        [523, 9, 30, 43, 14, 42],
        [600, 10, 25, 42, 11, 41],
        [672, 12, 27, 40, 13, 39],
        [746, 12, 27, 40, 13, 39]
    ],
    idle: [
        [6, 64, 27, 40, 13, 39],
        [80, 64, 27, 40, 13, 39],
        [154, 64, 27, 40, 13, 39],
        [229, 64, 25, 40, 12, 39],
        [303, 64, 26, 40, 12, 39]
    ],
    r_action: [
        [11, 117, 22, 39, 8, 38],
        [85, 118, 24, 38, 8, 38],
        [162, 129, 38, 27, 5, 26],
        [236, 129, 55, 27, 5, 26],
        [310, 127, 58, 29, 5, 28],
        [384, 125, 57, 31, 5, 30],
        [458, 125, 51, 31, 5, 30],
        [532, 130, 47, 26, 5, 25],
        [606, 130, 38, 26, 5, 25],
        [680, 129, 38, 27, 5, 26],
        [751, 118, 24, 38, 8, 38],
        [822, 116, 25, 40, 11, 39],
        [894, 116, 27, 40, 13, 39]
    ],
    attack: [
        [9, 169, 32, 39, 18, 38],
        [87, 169, 36, 39, 22, 38],
        [171, 170, 34, 38, 20, 37],
        [263, 168, 24, 40, 10, 39],
        [341, 168, 65, 40, 14, 39],
        [425, 167, 44, 41, 12, 40],
        [508, 166, 27, 42, 11, 41],
        [588, 167, 27, 41, 13, 40]
    ],
    defend: [
        [6, 220, 27, 40, 13, 39],
        [84, 220, 38, 40, 9, 39],
        [153, 220, 38, 40, 14, 39],
        [231, 220, 29, 40, 10, 39],
        [307, 219, 21, 41, 8, 40],
        [379, 220, 25, 40, 10, 39],
        [453, 220, 25, 40, 10, 39],
        [527, 220, 25, 40, 10, 39],
        [602, 220, 24, 40, 9, 39]
    ],
    hurt: [
        [8, 272, 33, 36, 19, 39]
    ],
    downed: [
        [90, 301, 29, 12, 17, 11]
    ],
    magic: [
        [11, 332, 32, 40, 13, 39],
        [12, 392, 31, 40, 12, 39],
        [91, 392, 31, 40, 12, 39],
        [170, 392, 31, 40, 12, 39],
        [249, 392, 32, 40, 12, 39],
        [328, 392, 31, 40, 12, 39],
        [408, 392, 30, 40, 11, 39],
        [487, 392, 25, 40, 11, 39]
    ]
};

const RALSEI_ANIMS = {
    intro:    { ticks: 4 },
    idle:     { loop: true, ticks: 8 },
    r_action: { ticks: 4 },
    attack:   { ticks: 4, dx: [0, 3, 6, 10, 12, 10, 5, 0] },
    defend:   { ticks: 4 },
    hurt:     { ticks: 30 },
    downed:   { ticks: 1 },
    magic:    { ticks: 5 }
};

const SUSIE_FRAMES = {
    idle: [
        [5, 3, 54, 45, 30, 44],
        [64, 3, 54, 45, 30, 44],
        [123, 3, 54, 45, 30, 44],
        [182, 3, 54, 45, 30, 44]
    ],
    attack: [
        [5, 53, 103, 71, 26, 67],
        [113, 53, 103, 71, 41, 68],
        [221, 53, 103, 71, 41, 68],
        [329, 53, 103, 71, 41, 68]
    ],
    s_act_prep: [
        [5, 129, 103, 71, 31, 68]
    ],
    s_act: [
        [220, 129, 103, 71, 31, 68],
        [328, 129, 103, 71, 31, 68],
        [436, 129, 103, 71, 31, 68],
        [544, 129, 103, 71, 31, 68],
        [652, 129, 103, 71, 31, 68],
        [760, 129, 103, 71, 31, 68],
        [868, 129, 103, 71, 31, 68],
        [976, 129, 103, 71, 31, 68],
        [1084, 129, 103, 71, 31, 68],
        [1192, 129, 103, 71, 31, 68],
        [1300, 129, 103, 71, 32, 67]
    ],
    attack_prep: [
        [5, 205, 103, 71, 31, 68]
    ],
    magic_prep: [
        [5, 281, 82, 62, 30, 58],
        [179, 281, 82, 62, 30, 58],
        [266, 281, 82, 62, 30, 58],
        [353, 281, 82, 62, 30, 58]
    ],
    spare: [
        [5, 348, 82, 77, 30, 73],
        [92, 348, 82, 77, 30, 73],
        [179, 348, 82, 77, 30, 73],
        [266, 348, 82, 77, 30, 73],
        [353, 348, 82, 77, 30, 73],
        [440, 348, 82, 77, 30, 73],
        [527, 348, 82, 77, 30, 73],
        [614, 348, 82, 77, 30, 73],
        [701, 348, 82, 77, 30, 73]
    ],
    rude_buster: [
        [5, 430, 123, 79, 52, 76],
        [133, 430, 123, 79, 53, 76],
        [261, 430, 123, 79, 58, 76],
        [389, 430, 123, 79, 57, 76],
        [517, 430, 123, 79, 57, 76],
        [645, 430, 123, 79, 57, 76],
        [773, 430, 123, 79, 47, 76],
        [901, 430, 123, 79, 47, 76],
        [1029, 430, 123, 79, 48, 76],
        [1157, 430, 123, 79, 48, 76],
        [1285, 430, 123, 79, 49, 76],
        [1413, 430, 123, 79, 48, 76],
        [1541, 430, 123, 79, 48, 76],
        [1669, 430, 123, 79, 48, 76],
        [1797, 430, 123, 79, 48, 76]
    ],
    item_prep: [
        [5, 514, 55, 45, 30, 44],
        [65, 514, 55, 45, 30, 44]
    ],
    item_exec: [
        [5, 564, 55, 45, 30, 44],
        [65, 564, 55, 45, 30, 44],
        [125, 564, 55, 45, 30, 44],
        [185, 564, 55, 45, 30, 44],
        [245, 564, 55, 45, 30, 44]
    ],
    defend: [
        [5, 614, 56, 66, 27, 66],
        [66, 614, 56, 66, 26, 66],
        [127, 614, 56, 66, 27, 66],
        [188, 614, 56, 66, 28, 66],
        [249, 614, 56, 66, 28, 66],
        [310, 614, 56, 66, 28, 66]
    ],
    hurt: [
        [5, 685, 54, 45, 30, 44]
    ],
    downed: [
        [123, 685, 60, 46, 39, 44]
    ]
};

const SUSIE_WAVE = [
    [788, 348, 44, 62],
    [836, 348, 44, 62],
    [884, 348, 44, 62],
    [932, 348, 44, 62],
    [980, 348, 44, 62],
    [1028, 348, 44, 62],
    [1076, 348, 44, 62],
    [1124, 348, 44, 62],
    [1172, 348, 44, 62],
    [1220, 348, 44, 62],
    [1268, 348, 44, 62],
    [1316, 348, 44, 62],
    [1364, 348, 44, 62],
    [1412, 348, 44, 62]
];

const SUSIE_ANIMS = {
    idle:         { loop: true, ticks: 8 },
    attack:       { ticks: 4, dx: [0, 8, 8, 3] },
    s_act_prep:   { ticks: 10 },
    s_act:        { ticks: 4 },
    attack_prep:  { ticks: 10 },
    magic_prep:   { loop: true, loopFrom: 1, ticks: 6 },
    spare:        { ticks: 5 },
    rude_buster:  { ticks: 4 },
    item_prep:    { loop: true, ticks: 10 },
    item_exec:    { ticks: 5 },
    defend:       { ticks: 4 },
    hurt:         { ticks: 30 },
    downed:       { ticks: 8 }
};

const SPRITE_CONFIGS = {
    kris: {
        sheet: krisSheet,
        frames: KRIS_FRAMES,
        anims: KRIS_ANIMS,
        prepareActions: ['ACT', 'SPARE'],
        introAnim: 'attack'
    },
    ralsei: {
        sheet: ralseiSheet,
        frames: RALSEI_FRAMES,
        anims: RALSEI_ANIMS,
        prepareActions: [],
        introAnim: 'intro'
    },
    susie: {
        sheet: susieSheet,
        refW: 1925,
        refH: 733,
        frames: SUSIE_FRAMES,
        anims: SUSIE_ANIMS,
        prepareFor: cmd => {
            if (cmd.action === 'FIGHT') return 'attack_prep';
            if (cmd.action === 'ITEM')  return 'item_prep';
            if (cmd.action === 'SPARE') return 's_act_prep';
            if (cmd.action === 'MAGIC') return cmd.spell.kind === 'mercy' ? 's_act_prep' : 'magic_prep';
            return null;
        },
        introAnim: 'attack'
    }
};

const IDLE_SPEED = 0.75, ANIM_SPEED = 1;
const animSpeed = name => name === 'idle' ? IDLE_SPEED
                        : (name === 'hurt' || name === 'downed') ? 0.5
                        : ANIM_SPEED;
const animLength = (cfg, name) => Math.ceil(cfg.frames[name].length * cfg.anims[name].ticks / animSpeed(name));

function restingAnimName(m) {
    const cfg = SPRITE_CONFIGS[m.id];
    if (m.downed) return 'downed';
    if (m.defending) return 'defend';
    if (cfg && m.pending) {
        if (cfg.prepareFor) {
            const p = cfg.prepareFor(m.pending);
            if (p && cfg.frames[p]) return p;
        } else if (cfg.prepareActions && cfg.prepareActions.includes(m.pending.action)) {
            return 'prepare';
        }
    }
    return 'idle';
}

function playOneShot(m, name) {
    const cfg = SPRITE_CONFIGS[m.id];
    if (cfg && cfg.frames[name]) {
        m.anim = { name, frame: 0, t: 0, oneShot: true };
    }
}

function playCommandAnim(cmd) {
    const m = cmd.member;
    const cfg = SPRITE_CONFIGS[m.id];
    if (!cfg) return 0;

    let animName = null;
    if (m.id === 'kris') {
        if (cmd.action === 'ITEM') animName = 'item';
        else if (cmd.action === 'ACT' || cmd.action === 'SPARE') animName = 'act';
    } else if (m.id === 'ralsei') {
        if (cmd.action === 'MAGIC') {
            animName = cmd.spell.kind === 'mercy' ? 'r_action' : 'magic';
        } else if (cmd.action === 'ITEM') {
            animName = 'magic';
        } else if (cmd.action === 'SPARE') {
            animName = 'r_action';
        }
    } else if (m.id === 'susie') {
        if (cmd.action === 'MAGIC') {
            animName = cmd.spell.kind === 'mercy' ? 's_act' : 'rude_buster';
        } else if (cmd.action === 'ITEM') {
            animName = 'item_exec';
        } else if (cmd.action === 'SPARE') {
            animName = 'spare';
        }
    }

    if (!animName || !cfg.frames[animName]) return 0;
    playOneShot(m, animName);
    return animLength(cfg, animName);
}

function stepAnimation(m) {
    const cfg = SPRITE_CONFIGS[m.id];
    if (!cfg) return;

    const rest = restingAnimName(m);
    if (!m.anim || (m.downed && m.anim.name !== 'downed') || (!m.anim.oneShot && m.anim.name !== rest)) {
        m.anim = { name: rest, frame: 0, t: 0, oneShot: false };
    }
    const a = m.anim;
    const def = cfg.anims[a.name];
    const last = cfg.frames[a.name].length - 1;

    a.t += animSpeed(a.name);
    if (a.t >= def.ticks) {
        a.t -= def.ticks;
        if (a.frame < last) a.frame++;
        else if (def.loop) a.frame = def.loopFrom || 0;
        else if (a.oneShot) m.anim = { name: rest, frame: 0, t: 0, oneShot: false };
    }

    const target = (def.dx ? def.dx[m.anim.frame] : 0) || 0;
    m.sx += (target - m.sx) * 0.194;
}

function updateAnimations() {
    party.forEach(m => { if (SPRITE_CONFIGS[m.id]) stepAnimation(m); });
    enemies.forEach(e => { if (!e.spared) stepEnemyAnimation(e); });
}

function drawMemberSprite(m, x, feetY) {
    const cfg = SPRITE_CONFIGS[m.id];
    if (!cfg || !m.anim || !cfg.sheet.img.complete || !cfg.sheet.img.naturalWidth) return false;
    const f = cfg.frames[m.anim.name][m.anim.frame];
    const S = SPRITE_SCALE;
    const rx = cfg.refW ? cfg.sheet.img.naturalWidth / cfg.refW : 1;
    const ry = cfg.refH ? cfg.sheet.img.naturalHeight / cfg.refH : 1;
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(
        cfg.sheet.drawable,
        Math.round(f[0] * rx),
        Math.round(f[1] * ry),
        Math.round(f[2] * rx),
        Math.round(f[3] * ry),
        Math.round(x + m.sx * S - f[4] * S),
        Math.round(feetY - f[5] * S),
        f[2] * S,
        f[3] * S
    );
    return true;
}

// ============================================================================
// CUSTOM ENEMY / BOSS SPRITE ANIMATOR
// ============================================================================
function parseFrameRange(spec, totalFrames) {
    if (typeof spec === 'number') return [Math.min(spec, totalFrames - 1)];
    const out = [];
    for (const part of String(spec).split(',')) {
        const trimmed = part.trim();
        if (trimmed.includes('-')) {
            const [a, b] = trimmed.split('-').map(n => parseInt(n.trim(), 10));
            for (let i = a; i <= b && i < totalFrames; i++) out.push(i);
        } else {
            const idx = parseInt(trimmed, 10);
            if (!Number.isNaN(idx) && idx < totalFrames) out.push(idx);
        }
    }
    return out.length > 0 ? out : [0];
}

async function setupEnemyVisuals(enemy) {
    if (!enemy.sprite) return;
    let asset = null;

    if (enemy.sprite.toLowerCase().endsWith('.gif')) {
        asset = await loadAnimatedAsset(enemy.sprite, 0, 'enemy');
    } else {
        const img = await fetchModImage(enemy.sprite, 'enemy').catch(() => null);
        if (img) {
            const fw = enemy.frameW || img.naturalWidth;
            const fh = enemy.frameH || img.naturalHeight;
            const cols = Math.max(1, Math.floor(img.naturalWidth / fw));
            const rows = Math.max(1, Math.floor(img.naturalHeight / fh));
            const frames = [];
            for (let r = 0; r < rows; r++) {
                for (let c = 0; c < cols; c++) {
                    const fc = document.createElement('canvas');
                    fc.width = fw;
                    fc.height = fh;
                    fc.getContext('2d').drawImage(img, c * fw, r * fh, fw, fh, 0, 0, fw, fh);
                    frames.push({ canvas: fc, delayMs: Math.round(1000 / (enemy.fps || 8)) });
                }
            }
            asset = { frames, w: fw, h: fh };
        }
    }

    if (!asset || asset.frames.length === 0) return;
    enemy.asset = asset;

    // Build named animations from [ENEMY_ANIM:name] blocks or default to all frames
    const builtAnims = {};
    for (const [animName, def] of Object.entries(enemy.anims || {})) {
        builtAnims[animName] = {
            indices: parseFrameRange(def.frames, asset.frames.length),
            ticks: def.ticks || 8,
            loop: def.loop !== false
        };
    }
    if (!builtAnims.idle) {
        builtAnims.idle = {
            indices: asset.frames.map((_, i) => i),
            ticks: Math.max(2, Math.round((asset.frames[0].delayMs || 100) / STEP_MS)),
            loop: true
        };
    }
    enemy.builtAnims = builtAnims;
    enemy.anim = { name: 'idle', idx: 0, t: 0, oneShot: false };
}

function playEnemyAnim(enemy, name) {
    if (!enemy || !enemy.builtAnims || !enemy.builtAnims[name]) return;
    enemy.anim = { name, idx: 0, t: 0, oneShot: !enemy.builtAnims[name].loop };
}

function stepEnemyAnimation(enemy) {
    if (!enemy.builtAnims || !enemy.anim) return;
    const def = enemy.builtAnims[enemy.anim.name];
    if (!def) return;
    enemy.anim.t++;
    if (enemy.anim.t >= def.ticks) {
        enemy.anim.t = 0;
        if (enemy.anim.idx + 1 < def.indices.length) {
            enemy.anim.idx++;
        } else if (def.loop) {
            enemy.anim.idx = 0;
        } else {
            enemy.anim = { name: 'idle', idx: 0, t: 0, oneShot: false };
        }
    }
}

// ============================================================================
// BATTLE STATE & MOD CONFIGURATION
// ============================================================================
let loadedModConfig = null;
let party, enemies, items;
let currentState, currentPartyIndex, selectedAction, menu;
let tensionPoints, flavorText;
let stepQueue, fightQueue, stepTimer, delayed;
let attackTracks, starParticles;
let bullets, enemyTurnTimer, soulInvuln, soulGrazing;
let effects = [];
const queuedCommands = [];

// Phase & GIF attack state
let totalTurn = 1;
let phaseTurn = 1;
let currentPhaseIndex = 0;
let triggeredPhaseNums = new Set();
let pendingDialogue = null; // { text, speaker, onDone }
let dialogueCharCount = 0;
let activeAttack = null; // { file, asset, damage, duration, fps, elapsedMs, frameIdx, frameTimerMs }
let targetArena = { w: 180, h: 150 };

const TARGET_LINE_X = 110;
const arena = { x: 230, y: 115, w: 180, h: 150 };
const soul = { x: 320, y: 190, radius: 6, speed: 1.5 };
const keys = {};

// Offscreen collision canvas sized strictly to the battle arena
const hitCanvas = document.createElement('canvas');
const hitCtx = hitCanvas.getContext('2d', { willReadFrequently: true });

function initBattle() {
    const mod = loadedModConfig;
    battleEpoch++;
    preparingEnemyTurn = false;

    // 0. Load mod background (.gif or .png) or fall back to GAME/ASSETS/background.gif
    const modBg = mod && (mod.background || mod.bg);
    const modBgFps = mod && (mod.bgFps || mod.backgroundFps);
    setBattleBackground(modBg, modBgFps);

    // 1. Party setup (supports INI overrides for maxHp, power, def, magic, color, name)
    const baseParty = [
        { id: 'kris',   name: 'KRIS',   hp: 90,  maxHp: 90,  power: 35, def: 0, magic: 0,  color: '#00ffff' },
        { id: 'susie',  name: 'SUSIE',  hp: 110, maxHp: 110, power: 50, def: 0, magic: 10, color: '#ff00ff' },
        { id: 'ralsei', name: 'RALSEI', hp: 70,  maxHp: 70,  power: 25, def: 0, magic: 20, color: '#00ff21' }
    ];
    party = baseParty.map(base => {
        const over = (mod && mod.party && mod.party[base.id]) || {};
        const maxHp = over.maxHp ?? base.maxHp;
        return {
            ...base,
            ...over,
            maxHp,
            hp: over.hp ?? maxHp,
            downed: false,
            defending: false,
            sx: 0,
            anim: null,
            pending: null
        };
    });

    // 2. Enemies / Boss setup
    if (mod && mod.enemies.length > 0) {
        enemies = mod.enemies.map(e => ({
            ...e,
            hp: e.hp ?? 100,
            maxHp: e.hp ?? 100,
            def: e.def ?? 0,
            mercy: 0,
            tired: false,
            spared: false,
            target: null,
            asset: null,
            builtAnims: null,
            anim: null
        }));
        enemies.forEach(e => setupEnemyVisuals(e));
    } else {
        enemies = [
            { name: 'Rudinn', hp: 100, maxHp: 100, def: 0, mercy: 0, tired: false, spared: false, x: 470, y: 30,  target: null, flavor: ['* Rudinn glistens neutrally.'], acts: ['Check', 'Flatter'] },
            { name: 'Hathy',  hp: 120, maxHp: 120, def: 0, mercy: 0, tired: false, spared: false, x: 470, y: 130, target: null, flavor: ['* Hathy is thinking about love.'], acts: ['Check', 'Flatter'] }
        ];
    }

    // 3. Arena defaults
    targetArena.w = (mod && mod.arena.w) || 180;
    targetArena.h = (mod && mod.arena.h) || 150;
    arena.w = targetArena.w;
    arena.h = targetArena.h;
    arena.x = Math.round(V_WIDTH / 2 - arena.w / 2);
    arena.y = Math.round(190 - arena.h / 2);

    items = [
        { name: 'Dark Candy',  heal: 40, count: 3 },
        { name: 'Revive Mint', heal: 90, count: 1 }
    ];

    tensionPoints = 16;
    totalTurn = 1;
    phaseTurn = 1;
    currentPhaseIndex = mod ? mod.phases.findIndex(p => p.num === 1) : -1;
    triggeredPhaseNums = new Set([1]);
    pendingDialogue = null;
    activeAttack = null;

    const startPhase = getCurrentPhase();
    setupBattleAudio(mod, (startPhase && startPhase.music) || (mod && mod.audio.music));

    flavorText = getCurrentFlavorPool()[0] || '* Enemies blocked the way!';
    currentState = STATES.ACTION_SELECT;
    currentPartyIndex = 0;
    selectedAction = 0;
    menu = null;
    queuedCommands.length = 0;
    stepQueue = [];
    fightQueue = [];
    stepTimer = 0;
    delayed = null;
    attackTracks = [];
    starParticles = [];
    bullets = [];
    effects = [];
    enemyTurnTimer = 0;
    party.forEach(m => {
        const cfg = SPRITE_CONFIGS[m.id];
        if (cfg && cfg.introAnim) playOneShot(m, cfg.introAnim);
    });
    soulInvuln = 0;
    soulGrazing = false;

    // Preload attack GIFs referenced in the INI so there is zero stutter mid-battle
    if (mod) {
        const allFiles = new Set();
        const collectSeq = seq => {
            if (!seq) return;
            Object.values(seq.turns).forEach(pool => pool.forEach(f => allFiles.add(f)));
        };
        collectSeq(mod.attacks);
        mod.phases.forEach(p => collectSeq(p.attacks));
        allFiles.forEach(f => {
            const meta = mod.attackMeta[f.toLowerCase()] || {};
            loadAnimatedAsset(meta.file || f);
        });
    }
}

function getCurrentPhase() {
    if (!loadedModConfig || loadedModConfig.phases.length === 0) return null;
    if (currentPhaseIndex < 0) return null;
    return loadedModConfig.phases[currentPhaseIndex] || null;
}

function getCurrentFlavorPool() {
    const phase = getCurrentPhase();
    if (phase && phase.flavor && phase.flavor.length > 0) return phase.flavor;
    const pool = activeEnemies();
    const list = [];
    pool.forEach(e => {
        if (Array.isArray(e.flavor)) list.push(...e.flavor);
        else if (e.flavor) list.push(e.flavor);
    });
    return list.length > 0 ? list : ['* The battle continues!'];
}

function getCurrentAttackSequence() {
    const phase = getCurrentPhase();
    if (phase && phase.attacks && phase.attacks.maxTurn > 0) return phase.attacks;
    if (loadedModConfig && loadedModConfig.attacks.maxTurn > 0) return loadedModConfig.attacks;
    return null;
}

const activeEnemies = () => enemies.filter(e => !e.spared);
const consciousParty = () => party.filter(p => !p.downed);
const currentActions = () => ACTIONS_BY_MEMBER[party[currentPartyIndex].id];

// --- Canvas letterboxing ---
let scale = 1, offsetX = 0, offsetY = 0;
function resizeCanvas() {
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
    scale = Math.min(canvas.width / V_WIDTH, canvas.height / V_HEIGHT);
    offsetX = (canvas.width - V_WIDTH * scale) / 2;
    offsetY = (canvas.height - V_HEIGHT * scale) / 2;
}
window.addEventListener('resize', resizeCanvas);
resizeCanvas();

// --- Keyboard ---
window.addEventListener('keydown', (e) => {
    const key = e.key.toLowerCase();
    keys[key] = true;
    if (['arrowup', 'arrowdown', 'arrowleft', 'arrowright', ' '].includes(key)) e.preventDefault();
    if (e.repeat) return;
    if (key === 'm') { toggleMute(); return; }

    const confirm = key === 'z' || key === 'enter';
    const cancel  = key === 'x' || key === 'shift';

    switch (currentState) {
        case STATES.ACTION_SELECT: {
            const len = currentActions().length;
            const before = selectedAction;
            if (key === 'arrowright' || key === 'd') selectedAction = (selectedAction + 1) % len;
            if (key === 'arrowleft'  || key === 'a') selectedAction = (selectedAction - 1 + len) % len;
            if (selectedAction !== before) playSfx('menu_move');
            if (confirm) confirmActionSelect();
            if (cancel)  cancelPreviousCommand();
            break;
        }
        case STATES.SUB_MENU: {
            const len = menuOptions().length;
            const before = menu.index;
            if (key === 'arrowdown' || key === 's') menu.index = Math.min(menu.index + 1, len - 1);
            if (key === 'arrowup'   || key === 'w') menu.index = Math.max(menu.index - 1, 0);
            if (menu.index !== before) playSfx('menu_move');
            if (confirm) confirmSubMenu();
            if (cancel)  backOutOfSubMenu();
            break;
        }
        case STATES.ATTACK_BAR:
            if (confirm) hitLeftmostReticle();
            break;
        case STATES.ENEMY_DIALOGUE:
            if (pendingDialogue) {
                if (cancel) {
                    dialogueCharCount = pendingDialogue.text.length;
                } else if (confirm) {
                    playSfx('menu_select');
                    if (dialogueCharCount < pendingDialogue.text.length) {
                        dialogueCharCount = pendingDialogue.text.length;
                    } else {
                        const done = pendingDialogue.onDone;
                        pendingDialogue = null;
                        if (done) done();
                    }
                }
            }
            break;
        case STATES.VICTORY:
        case STATES.GAME_OVER:
            if (confirm) { playSfx('menu_select'); initBattle(); }
            break;
    }
});
window.addEventListener('keyup', (e) => { keys[e.key.toLowerCase()] = false; });
window.addEventListener('blur', () => { for (const k in keys) keys[k] = false; });

// --- Command selection ---
function confirmActionSelect() {
    const actor = party[currentPartyIndex];
    const action = currentActions()[selectedAction];
    menu = { action, stage: null, index: 0, target: null, spell: null, item: null };

    if (action === 'ITEM' && !items.some(i => i.count > 0)) {
        playSfx('menu_denied');
        menu = null;
        return;
    }
    playSfx('menu_select');

    if (action === 'DEFEND') {
        menu = null;
        queueMemberAction({ member: actor, action: 'DEFEND', phase: PHASE.DEFEND });
        return;
    }
    if (action === 'ITEM') {
        menu.stage = 'ITEM_LIST';
    } else if (action === 'MAGIC') {
        menu.stage = 'MAGIC_LIST';
    } else {
        menu.stage = 'TARGET';
    }
    currentState = STATES.SUB_MENU;
}

function menuOptions() {
    const actor = party[currentPartyIndex];
    switch (menu.stage) {
        case 'TARGET':
            return activeEnemies().map(e => ({
                label: e.name, enemy: e,
                extra: `HP ${Math.ceil(e.hp / e.maxHp * 100)}%  MERCY ${e.mercy}%`
            }));
        case 'ACT_LIST': {
            const actNames = (menu.target && menu.target.acts) || ['Check', 'Flatter'];
            return actNames.map(name => ({ label: name }));
        }
        case 'MAGIC_LIST':
            return SPELLS[actor.id].map(s => ({
                label: s.name, spell: s, extra: `${s.cost}% TP`, enabled: tensionPoints >= s.cost
            }));
        case 'ITEM_LIST':
            return items.filter(i => i.count > 0).map(i => ({
                label: `${i.name} x${i.count}`, item: i, extra: `+${i.heal} HP`
            }));
        case 'PARTY':
            return party.map(p => ({
                label: p.name, member: p, extra: p.downed ? 'DOWN' : `${p.hp}/${p.maxHp}`
            }));
    }
    return [];
}

function confirmSubMenu() {
    const opt = menuOptions()[menu.index];
    if (!opt || opt.enabled === false) { playSfx('menu_denied'); return; }
    playSfx('menu_select');
    const actor = party[currentPartyIndex];

    switch (menu.stage) {
        case 'TARGET':
            menu.target = opt.enemy;
            if (menu.action === 'FIGHT') {
                queueMemberAction({ member: actor, action: 'FIGHT', target: opt.enemy, phase: PHASE.FIGHT });
            } else if (menu.action === 'SPARE') {
                queueMemberAction({ member: actor, action: 'SPARE', target: opt.enemy, phase: PHASE.SPARE });
            } else if (menu.action === 'ACT') {
                menu.stage = 'ACT_LIST'; menu.index = 0;
            } else if (menu.action === 'MAGIC') {
                queueSpell(actor, menu.spell, opt.enemy);
            }
            break;
        case 'ACT_LIST':
            queueMemberAction({ member: actor, action: 'ACT', target: menu.target, actType: opt.label, phase: PHASE.ACT });
            break;
        case 'MAGIC_LIST':
            menu.spell = opt.spell;
            menu.stage = opt.spell.target === 'party' ? 'PARTY' : 'TARGET';
            menu.index = 0;
            break;
        case 'ITEM_LIST':
            menu.item = opt.item;
            menu.stage = 'PARTY';
            menu.index = 0;
            break;
        case 'PARTY':
            if (menu.action === 'ITEM') {
                queueMemberAction({ member: actor, action: 'ITEM', item: menu.item, target: opt.member, phase: PHASE.ITEM });
            } else {
                queueSpell(actor, menu.spell, opt.member);
            }
            break;
    }
}

function queueSpell(actor, spell, target) {
    queueMemberAction({
        member: actor, action: 'MAGIC', spell, target,
        phase: spell.kind === 'mercy' ? PHASE.ACT : PHASE.MAGIC
    });
}

function backOutOfSubMenu() {
    playSfx('menu_back');
    switch (menu.stage) {
        case 'ACT_LIST': menu.stage = 'TARGET'; menu.index = 0; return;
        case 'PARTY':    menu.stage = menu.action === 'ITEM' ? 'ITEM_LIST' : 'MAGIC_LIST'; menu.index = 0; return;
        case 'TARGET':
            if (menu.action === 'MAGIC') { menu.stage = 'MAGIC_LIST'; menu.index = 0; return; }
            break;
    }
    menu = null;
    currentState = STATES.ACTION_SELECT;
}

function queueMemberAction(cmd) {
    cmd.tpDelta = 0;
    if (cmd.action === 'DEFEND') cmd.tpDelta = addTP(16);
    if (cmd.action === 'MAGIC')  cmd.tpDelta = addTP(-cmd.spell.cost);
    if (cmd.action === 'ITEM')   cmd.item.count--;
    if (cmd.action === 'DEFEND') cmd.member.defending = true;
    cmd.member.pending = cmd;
    queuedCommands.push(cmd);
    menu = null;
    advanceToNextPartyMember();
}

function advanceToNextPartyMember() {
    currentPartyIndex++;
    while (currentPartyIndex < party.length && party[currentPartyIndex].downed) currentPartyIndex++;

    if (currentPartyIndex >= party.length) {
        startTurnExecution();
    } else {
        selectedAction = 0;
        currentState = STATES.ACTION_SELECT;
    }
}

function cancelPreviousCommand() {
    if (queuedCommands.length === 0) return;
    playSfx('menu_back');
    const cmd = queuedCommands.pop();
    addTP(-cmd.tpDelta);
    if (cmd.action === 'ITEM') cmd.item.count++;
    if (cmd.action === 'DEFEND') cmd.member.defending = false;
    cmd.member.pending = null;
    currentPartyIndex = party.indexOf(cmd.member);
    selectedAction = 0;
    menu = null;
    currentState = STATES.ACTION_SELECT;
}

// --- Party turn execution ---
function byOrder(a, b) {
    return (a.phase - b.phase) || (party.indexOf(a.member) - party.indexOf(b.member));
}

function startTurnExecution() {
    const sorted = queuedCommands.slice().sort(byOrder);
    stepQueue  = sorted.filter(c => c.phase < PHASE.FIGHT);
    fightQueue = sorted.filter(c => c.phase === PHASE.FIGHT);
    queuedCommands.length = 0;
    flavorText = "";
    currentState = STATES.EXECUTE_TURNS;
    stepTimer = 0;
}

function updateExecution() {
    if (--stepTimer > 0) return;
    if (effects.length > 0) return;

    if (stepQueue.length > 0) {
        const cmd = stepQueue.shift();
        const executed = runCommand(cmd);
        if (checkVictory()) return;
        stepTimer = executed ? playCommandAnim(cmd) : 0;
        return;
    }
    if (fightQueue.length > 0) {
        beginAttackBars();
        return;
    }
    prepareEnemyTurn();
}

function runCommand(cmd) {
    const m = cmd.member;
    const t = cmd.target;
    m.pending = null;

    switch (cmd.action) {
        case 'DEFEND':
            m.defending = true;
            playSfx('defend');
            return true;

        case 'ACT': {
            if (t.spared) return false;
            playSfx('act');
            const actDef = loadedModConfig && loadedModConfig.acts[cmd.actType.toLowerCase()];
            if (actDef) {
                if (actDef.mercy) addMercy(t, actDef.mercy);
                if (actDef.tired && t.canTire !== false) t.tired = true;
                if (actDef.text) flavorText = actDef.text;
            } else if (cmd.actType.toLowerCase() !== 'check') {
                addMercy(t, 50);
            }
            return true;
        }

        case 'ITEM':
            healMember(t, cmd.item.heal);
            playSfx('item');
            return true;

        case 'SPARE':
            if (t.spared) return false;
            if (t.mercy >= 100) {
                t.spared = true;
                playSfx('spare');
            } else {
                addMercy(t, 10);
                playSfx('act');
            }
            return true;

        case 'MAGIC':
            return runSpell(cmd);
    }
    return false;
}

function runSpell(cmd) {
    const { member: m, spell: s, target: t } = cmd;
    if (s.target === 'enemy' && t.spared) return false;

    switch (s.kind) {
        case 'damage': {
            playSfx('magic');
            // Scales with Susie's magic stat (default magic=10 gives original 2.5x multiplier)
            const mult = 2.5 + Math.max(0, (m.magic || 0) - 10) * 0.05;
            spawnRudeBusterWave(m, t, hitTarget => {
                applyDamage(m, hitTarget, mult);
                checkVictory();
            });
            break;
        }
        case 'pacify':
            playSfx(t.tired ? 'spare' : 'menu_denied');
            if (t.tired) t.spared = true;
            break;
        case 'heal':
            // Scales with Ralsei's magic stat (default magic=20 heals 40 HP)
            healMember(t, 20 + (m.magic || 0));
            playSfx('heal');
            break;
        case 'mercy':
            addMercy(t, 25);
            playSfx('magic');
            break;
    }
    return true;
}

function addMercy(enemy, amount) {
    enemy.mercy = Math.min(100, enemy.mercy + amount);
}

function healMember(member, amount) {
    member.hp = Math.min(member.maxHp, member.hp + amount);
    if (member.downed && member.hp > 0) member.downed = false;
}

function addTP(amount) {
    const before = tensionPoints;
    tensionPoints = Math.max(0, Math.min(100, tensionPoints + amount));
    return tensionPoints - before;
}

function checkVictory() {
    if (!enemies.every(e => e.spared)) return false;
    if (currentState !== STATES.VICTORY) {
        stopMusic();
        playSfx('victory');
    }
    party.forEach(m => {
        if (m.downed) { m.hp = Math.ceil(m.maxHp * 0.12); m.downed = false; }
        m.pending = null;
    });
    const dollars = 120 + Math.floor(tensionPoints);
    flavorText = (loadedModConfig && loadedModConfig.victoryText)
        || `* YOU WON! Got 0 EXP and ${dollars} D$. (Z to restart)`;
    currentState = STATES.VICTORY;
    stepQueue = []; fightQueue = []; attackTracks = []; delayed = null;
    return true;
}

// --- FIGHT minigame ---
function beginAttackBars() {
    currentState = STATES.ATTACK_BAR;
    attackTracks = fightQueue.splice(0).map((cmd, idx) => ({
        member: cmd.member,
        target: cmd.target,
        x: 520 + idx * 30 + Math.random() * 20,
        speed: (5 + Math.random() * 2) * 0.5,
        active: true,
        hitResult: null,
        color: cmd.member.color,
        trackY: 375 + idx * 22
    }));
}

function resolveAttackTarget(track) {
    if (track.target && !track.target.spared) return track.target;
    return activeEnemies()[0] || null;
}

function hitLeftmostReticle() {
    if (delayed) return;
    const active = attackTracks.filter(t => t.active);
    if (active.length === 0) return;
    active.sort((a, b) => a.x - b.x);
    const t = active[0];
    resolveTrack(t, Math.abs(t.x - TARGET_LINE_X));
}

function resolveTrack(t, dist) {
    t.active = false;
    t.member.pending = null;
    const target = resolveAttackTarget(t);
    if (!target) { t.hitResult = 'MISS'; checkAttackBarDone(); return; }
    t.target = target;

    if (dist <= 4) {
        t.hitResult = 'PERFECT';
        playSfx('attack_critical');
        playOneShot(t.member, 'attack');
        t.color = '#ffff00';
        addTP(6);
        spawnPerfectStars(TARGET_LINE_X, t.trackY);
        applyDamage(t.member, target, 1.5);
    } else if (dist <= 75) {
        t.hitResult = 'GOOD';
        playSfx('attack');
        playOneShot(t.member, 'attack');
        addTP(Math.floor(2 + (1 - dist / 75) * 2));
        applyDamage(t.member, target, 1.0 - dist / 100);
    } else {
        t.hitResult = 'MISS';
        playSfx('attack_miss');
        playOneShot(t.member, 'attack');
        if (target.def < 0) {
            applyDamage(t.member, target, 0.2);
        }
    }
    checkAttackBarDone();
}

function checkAttackBarDone() {
    if (delayed || !attackTracks.every(t => !t.active)) return;
    const waitFrames = attackTracks.reduce((max, t) => {
        const cfg = SPRITE_CONFIGS[t.member.id];
        return cfg && cfg.frames.attack ? Math.max(max, animLength(cfg, 'attack')) : max;
    }, 0);
    delayed = { frames: waitFrames, fn: () => { if (!checkVictory()) prepareEnemyTurn(); } };
}

function updateAttackTracks() {
    attackTracks.forEach(t => {
        if (!t.active) return;
        t.x -= t.speed;
        if (t.x < TARGET_LINE_X - 15) resolveTrack(t, Infinity);
    });
}

function updateParticles() {
    for (let i = starParticles.length - 1; i >= 0; i--) {
        const p = starParticles[i];
        p.x += p.vx; p.y += p.vy; p.life--;
        if (p.life <= 0) starParticles.splice(i, 1);
    }
}

function spawnPerfectStars(x, y) {
    for (let i = 0; i < 8; i++) {
        starParticles.push({ x, y, vx: (Math.random() - 0.5) * 2, vy: (Math.random() - 0.5) * 2, life: 50 });
    }
}

function applyDamage(attacker, enemy, multiplier) {
    const finalDamage = Math.max(1, Math.floor(attacker.power * multiplier - enemy.def));
    enemy.hp = Math.max(0, enemy.hp - finalDamage);
    playSfx('enemy_hit');

    if (enemy.hp <= 0) {
        enemy.spared = true;
    } else if (enemy.canTire !== false && enemy.hp < enemy.maxHp * 0.5) {
        enemy.tired = true;
    }
}

// ============================================================================
// BOSS PHASES, ATTACK SEQUENCING & DIALOGUE BUBBLES
// ============================================================================
function evaluatePhaseTriggers() {
    if (!loadedModConfig || loadedModConfig.phases.length === 0) return null;
    const primary = activeEnemies()[0] || enemies[0];
    if (!primary) return null;

    const hpPct = (primary.hp / primary.maxHp) * 100;
    const mercyPct = primary.mercy;

    for (let i = 0; i < loadedModConfig.phases.length; i++) {
        const p = loadedModConfig.phases[i];
        if (triggeredPhaseNums.has(p.num) || !p.trigger) continue;

        const [kind, rawVal] = String(p.trigger).split(':').map(s => s.trim().toLowerCase());
        let matched = false;

        if (kind === 'hp_below') {
            if (rawVal.endsWith('%')) matched = hpPct <= parseFloat(rawVal);
            else matched = primary.hp <= parseFloat(rawVal);
        } else if (kind === 'mercy_above') {
            matched = mercyPct >= parseFloat(rawVal);
        } else if (kind === 'turn') {
            matched = totalTurn >= parseInt(rawVal, 10);
        }

        if (matched) {
            triggeredPhaseNums.add(p.num);
            currentPhaseIndex = i;
            phaseTurn = 1;
            return p;
        }
    }
    return null;
}

function pickAttackForTurn(seq, turn) {
    if (!seq || seq.maxTurn <= 0) return null;
    let targetTurn = turn;
    if (targetTurn > seq.maxTurn) {
        if (seq.loop === 'last' || typeof seq.loop !== 'number') {
            targetTurn = seq.maxTurn;
        } else {
            const loopStart = Math.max(1, Math.min(seq.loop, seq.maxTurn));
            const span = seq.maxTurn - loopStart + 1;
            targetTurn = loopStart + ((turn - loopStart) % span);
        }
    }
    const pool = seq.turns[targetTurn] || [];
    if (pool.length === 0) return null;
    return pool[Math.floor(Math.random() * pool.length)];
}

let preparingEnemyTurn = false;
let battleEpoch = 0;

// Guarded wrapper: updateExecution() calls this every frame, and the real work is async.
function prepareEnemyTurn() {
    if (preparingEnemyTurn) return;
    preparingEnemyTurn = true;
    prepareEnemyTurnImpl()
        .catch(err => {
            console.error('prepareEnemyTurn failed, falling back to default attack:', err);
            activeAttack = null;
            snapArenaToTarget();
            beginEnemyTurnBullets();
        })
        .finally(() => { preparingEnemyTurn = false; });
}

async function prepareEnemyTurnImpl() {
    const epoch = battleEpoch;
    // 1. Check if a boss phase transition just occurred
    const newPhase = evaluatePhaseTriggers();
    const boss = activeEnemies()[0] || enemies[0];
    if (newPhase) {
        playSfx('phase');
        if (newPhase.music) playMusic(newPhase.music);
        if (newPhase.boss_anim && boss) playEnemyAnim(boss, newPhase.boss_anim);
        if (newPhase.background || newPhase.bg) {
            setBattleBackground(newPhase.background || newPhase.bg, newPhase.bgFps || newPhase.backgroundFps);
        }
    }

    // 2. Pick this turn's GIF/image attack from the active phase (or global [ATTACKS])
    const seq = getCurrentAttackSequence();
    const atkName = pickAttackForTurn(seq, phaseTurn);
    const meta = (atkName && loadedModConfig && loadedModConfig.attackMeta[atkName.toLowerCase()]) || {};

    let asset = null;
    if (atkName) {
        asset = await loadAnimatedAsset(meta.file || atkName);
        if (epoch !== battleEpoch) return; // battle was restarted / mod reloaded while loading
    }

    // Advanced mode: a full-screen 640x480 GIF that is not tied to the battle box
    const advanced = String(meta.mode || '').toLowerCase() === 'advanced';
    let error = '';
    if (advanced) {
        const file = String(meta.file || atkName);
        if (!asset) error = `${file} could not be loaded`;
        else if (!/\.gif$/i.test(file)) error = `${file} is not a .gif`;
        else if (asset.w !== V_WIDTH || asset.h !== V_HEIGHT) error = `${file} is ${asset.w}x${asset.h}, needs ${V_WIDTH}x${V_HEIGHT}`;
        if (error) {
            console.error(`Advanced attack "${atkName}": ${error}`);
            asset = null; // the built-in bullets play instead
        }
    }
    const warn = !isNone(meta.warn ?? true);
    if (asset && warn) asset.frames.forEach(frameHasWarning); // scan before the turn to avoid stutter

    const defaultW = (loadedModConfig && loadedModConfig.arena.w) || 180;
    const defaultH = (loadedModConfig && loadedModConfig.arena.h) || 150;
    const autoW = !advanced && asset ? asset.w : defaultW;
    const autoH = !advanced && asset ? asset.h : defaultH;

    activeAttack = atkName ? {
        name: atkName,
        asset,
        damage: meta.damage ?? 18,
        duration: meta.duration ?? 480,
        fps: meta.fps || null,
        // Box auto-matches the attack GIF/image size. [ATTACK] boxW/boxH still work as optional overrides.
        boxW: Math.max(48, Math.min(580, meta.boxW ?? autoW)),
        boxH: Math.max(48, Math.min(245, meta.boxH ?? autoH)),
        advanced: advanced && !error,
        freeSoul: advanced && !error && String(meta.soul || '').toLowerCase() === 'screen',
        error,
        warn,
        redShowing: false,
        sound: meta.sound || '',
        bossAnim: meta.boss_anim || '',
        dialogue: meta.dialogue || ''
    } : null;

    // Set target arena size (smoothly resizes during dialogue, or snaps immediately if no dialogue)
    targetArena.w = activeAttack ? activeAttack.boxW : ((loadedModConfig && loadedModConfig.arena.w) || 180);
    targetArena.h = activeAttack ? activeAttack.boxH : ((loadedModConfig && loadedModConfig.arena.h) || 150);

    const linesToSay = [];
    if (newPhase && newPhase.dialogue) linesToSay.push(newPhase.dialogue);
    if (activeAttack && activeAttack.dialogue) linesToSay.push(activeAttack.dialogue);

    if (linesToSay.length > 0 && boss) {
        startDialogueQueue(linesToSay, boss, () => beginEnemyTurnBullets());
    } else {
        snapArenaToTarget();
        beginEnemyTurnBullets();
    }
}

function startDialogueQueue(lines, speaker, onAllDone) {
    currentState = STATES.ENEMY_DIALOGUE;
    let idx = 0;
    const showNext = () => {
        if (idx >= lines.length) {
            snapArenaToTarget();
            onAllDone();
            return;
        }
        dialogueCharCount = 0;
        pendingDialogue = {
            text: lines[idx++],
            speaker,
            onDone: showNext
        };
    };
    showNext();
}

function updateEnemyDialogue() {
    if (!pendingDialogue) return;
    if (dialogueCharCount < pendingDialogue.text.length) {
        const shown = Math.floor(dialogueCharCount);
        dialogueCharCount += 0.65;
        const now = Math.floor(dialogueCharCount);
        if (now !== shown && now % 3 === 0 && pendingDialogue.text[now - 1] !== ' ') playSfx('text');
    }
    // Smoothly lerp the bullet board to the upcoming attack's dimensions while the boss talks
    arena.w += (targetArena.w - arena.w) * 0.18;
    arena.h += (targetArena.h - arena.h) * 0.18;
    arena.x = Math.round(V_WIDTH / 2 - arena.w / 2);
    arena.y = Math.round(190 - arena.h / 2);
}

function snapArenaToTarget() {
    arena.w = targetArena.w;
    arena.h = targetArena.h;
    arena.x = Math.round(V_WIDTH / 2 - arena.w / 2);
    arena.y = Math.round(190 - arena.h / 2);
}

function beginEnemyTurnBullets() {
    currentState = STATES.ENEMY_TURN;

    const boss = activeEnemies()[0] || enemies[0];
    if (activeAttack && activeAttack.bossAnim && boss) {
        playEnemyAnim(boss, activeAttack.bossAnim);
    }

    if (activeAttack) {
        activeAttack.frameIdx = 0;
        activeAttack.frameTimerMs = 0;
        const area = attackArea();
        hitCanvas.width = Math.round(area.w);
        hitCanvas.height = Math.round(area.h);
    }
    playSfx('attack_start');
    if (activeAttack && activeAttack.sound) playFileSfx(activeAttack.sound);
    updateAttackWarning(); // frame 1 may already be red

    const targets = consciousParty();
    activeEnemies().forEach(e => {
        e.target = targets[Math.floor(Math.random() * targets.length)];
    });

    soul.x = arena.x + arena.w / 2;
    soul.y = arena.y + arena.h / 2;
    bullets = [];
    enemyTurnTimer = activeAttack ? activeAttack.duration : 480;
    soulInvuln = 0;
    soulGrazing = false;
    phaseTurn++;
}

// ============================================================================
// ENEMY TURN & OFFSCREEN PIXEL COLLISION
// ============================================================================
// Screen rectangle the attack frame covers: the whole screen in advanced mode, else the box
function attackArea() {
    return activeAttack && activeAttack.advanced ? { x: 0, y: 0, w: V_WIDTH, h: V_HEIGHT } : arena;
}

function checkAttackPixels(frameCanvas) {
    hitCtx.imageSmoothingEnabled = false;
    hitCtx.clearRect(0, 0, hitCanvas.width, hitCanvas.height);
    hitCtx.drawImage(frameCanvas, 0, 0, hitCanvas.width, hitCanvas.height);

    const area = attackArea();
    const relX = Math.round(soul.x - area.x);
    const relY = Math.round(soul.y - area.y);
    const grazeRadius = 22;

    const x0 = Math.max(0, relX - grazeRadius);
    const y0 = Math.max(0, relY - grazeRadius);
    const w = Math.min(hitCanvas.width - x0, grazeRadius * 2);
    const h = Math.min(hitCanvas.height - y0, grazeRadius * 2);
    if (w <= 0 || h <= 0) return { hit: false, graze: false };

    const data = hitCtx.getImageData(x0, y0, w, h).data;
    const isMoving = Boolean(
        keys['arrowleft'] || keys['arrowright'] || keys['arrowup'] || keys['arrowdown'] ||
        keys['a'] || keys['d'] || keys['w'] || keys['s']
    );

    let hit = false;
    let graze = false;

    for (let py = 0; py < h; py++) {
        for (let px = 0; px < w; px++) {
            const i = (py * w + px) * 4;
            const r = data[i], g = data[i + 1], b = data[i + 2], a = data[i + 3];
            if (a < 128) continue;

            // Detect White (normal), Cyan (hurt if moving), Orange (hurt if still)
            const isWhite  = r > 230 && g > 230 && b > 230;
            const isCyan   = r < 80  && g > 200 && b > 220;
            const isOrange = r > 220 && g > 100 && g < 190 && b < 80;
            if (!isWhite && !isCyan && !isOrange) continue;

            const dist = Math.hypot((x0 + px) - relX, (y0 + py) - relY);
            if (dist <= soul.radius) {
                if (isWhite || (isCyan && isMoving) || (isOrange && !isMoving)) {
                    hit = true;
                }
            } else if (dist <= grazeRadius) {
                graze = true;
            }
        }
    }
    return { hit, graze };
}

function updateEnemyTurn() {
    enemyTurnTimer--;

    const spd = (keys['x'] || keys['shift']) ? soul.speed / 2 : soul.speed;
    const bounds = activeAttack && activeAttack.freeSoul ? attackArea() : arena;
    const minX = bounds.x + soul.radius + 4, maxX = bounds.x + bounds.w - soul.radius - 4;
    const minY = bounds.y + soul.radius + 4, maxY = bounds.y + bounds.h - soul.radius - 4;
    if (keys['arrowleft']  || keys['a']) soul.x = Math.max(minX, soul.x - spd);
    if (keys['arrowright'] || keys['d']) soul.x = Math.min(maxX, soul.x + spd);
    if (keys['arrowup']    || keys['w']) soul.y = Math.max(minY, soul.y - spd);
    if (keys['arrowdown']  || keys['s']) soul.y = Math.min(maxY, soul.y + spd);

    if (soulInvuln > 0) soulInvuln--;
    let grazing = false;

    // Mode A: GIF / Image pixel-based attack pattern
    if (activeAttack && activeAttack.asset && activeAttack.asset.frames.length > 0) {
        const frames = activeAttack.asset.frames;
        const curFrame = frames[activeAttack.frameIdx % frames.length];
        const frameDuration = activeAttack.fps ? (1000 / activeAttack.fps) : curFrame.delayMs;

        activeAttack.frameTimerMs += STEP_MS;
        if (activeAttack.frameTimerMs >= frameDuration) {
            activeAttack.frameTimerMs -= frameDuration;
            activeAttack.frameIdx = (activeAttack.frameIdx + 1) % frames.length;
            updateAttackWarning();
        }

        const res = checkAttackPixels(curFrame.canvas);
        if (soulInvuln <= 0 && res.hit) {
            const attacker = activeEnemies()[0];
            damageParty(attacker ? attacker.target : null, activeAttack.damage);
            soulInvuln = 90;
            if (currentState === STATES.GAME_OVER) return;
        } else if (res.graze) {
            grazing = true;
        }
    } else {
        // Mode B: Fallback built-in aimed bullets (when no GIF attack is active)
        if (enemyTurnTimer % 50 === 0 && enemyTurnTimer > 60) {
            activeEnemies().forEach(e => {
                const angle = Math.atan2(soul.y - (e.y + 20), soul.x - e.x);
                bullets.push({ x: e.x, y: e.y + 20, vx: Math.cos(angle) * 1.5, vy: Math.sin(angle) * 1.5, size: 6, target: e.target });
            });
        }

        for (let i = bullets.length - 1; i >= 0; i--) {
            const b = bullets[i];
            b.x += b.vx;
            b.y += b.vy;

            if (b.x < -30 || b.x > V_WIDTH + 30 || b.y < -30 || b.y > V_HEIGHT + 30) {
                bullets.splice(i, 1);
                continue;
            }

            const dist = Math.hypot(soul.x - b.x, soul.y - b.y);
            if (soulInvuln > 0) continue;

            if (dist < soul.radius + b.size) {
                damageParty(b.target, 18);
                soulInvuln = 90;
                bullets.splice(i, 1);
                if (currentState === STATES.GAME_OVER) return;
            } else if (dist < 22) {
                grazing = true;
            }
        }
    }

    if (grazing && !soulGrazing) playSfx('graze');
    soulGrazing = grazing;
    if (grazing) addTP(0.125);

    if (enemyTurnTimer <= 0) endEnemyTurn();
}

function damageParty(preferred, baseDamage = 18) {
    let victim = preferred && !preferred.downed ? preferred : null;
    if (!victim) {
        const c = consciousParty();
        if (c.length === 0) return;
        victim = c[Math.floor(Math.random() * c.length)];
    }

    const reduced = Math.max(1, baseDamage - (victim.def || 0));
    const dmg = victim.defending ? Math.max(1, Math.ceil(reduced * 0.6)) : reduced;
    victim.hp -= dmg;
    if (SPRITE_CONFIGS[victim.id] && !victim.defending) playOneShot(victim, 'hurt');

    if (victim.hp <= 0) {
        victim.hp = -Math.ceil(victim.maxHp * 0.5);
        victim.downed = true;
        victim.defending = false;
        playSfx('down');
    } else {
        playSfx('hurt');
    }
    if (consciousParty().length === 0) {
        stopMusic();
        playSfx('gameover');
        currentState = STATES.GAME_OVER;
        bullets = [];
        flavorText = (loadedModConfig && loadedModConfig.gameOverText)
            || "* THE WORLD WAS COVERED IN DARKNESS. (Z to retry)";
    }
}

function endEnemyTurn() {
    party.forEach(m => { m.defending = false; });
    enemies.forEach(e => playEnemyAnim(e, 'idle'));
    bullets = [];
    activeAttack = null;
    totalTurn++;
    beginPartyTurn();
}

function beginPartyTurn() {
    const revived = [];
    party.forEach(m => {
        if (!m.downed) return;
        m.hp += Math.ceil(m.maxHp * 0.13);
        if (m.hp > 0) {
            m.hp = Math.ceil(m.maxHp * 0.17);
            m.downed = false;
            revived.push(m.name);
        }
    });

    currentState = STATES.ACTION_SELECT;
    currentPartyIndex = 0;
    while (currentPartyIndex < party.length && party[currentPartyIndex].downed) currentPartyIndex++;
    selectedAction = 0;
    menu = null;

    if (revived.length > 0) {
        flavorText = `* ${revived.join(' and ')} stood back up!`;
    } else {
        const pool = getCurrentFlavorPool();
        flavorText = pool[Math.floor(Math.random() * pool.length)];
    }
}

// --- Rude Buster wave ---
const WAVE_DELAY = 24;
const WAVE_KEY_TOLERANCE = 40;
const WAVE_MAX_LIFE = 180;
const WAVE_TRAIL_DECAY = 0.08;
const WAVE_BAND = { x0: 784, x1: 1457, y0: 346, y1: 409 };

function enemyCenter(e) {
    if (e.asset) {
        const S = e.scale || 2;
        return { x: e.x + (e.asset.w * S) / 2, y: e.y + (e.asset.h * S) / 2 };
    }
    return { x: e.x + 20, y: e.y + 20 };
}

function spawnRudeBusterWave(member, target, onHit) {
    const feetY = PARTY_FEET_Y[party.indexOf(member)];
    const x0 = PARTY_X + 40, y0 = feetY - 40;
    const c = enemyCenter(target);
    effects.push({
        delay: WAVE_DELAY, age: 0,
        x: x0, y: y0,
        angle: Math.atan2(c.y - y0, c.x - x0),
        speed: 3,
        trail: [],
        hit: false,
        target, onHit
    });
}

function updateEffects() {
    if (!waveFrames) getWaveSheet();

    for (let i = effects.length - 1; i >= 0; i--) {
        const e = effects[i];
        if (e.delay > 0) { e.delay--; continue; }

        for (let j = e.trail.length - 1; j >= 0; j--) {
            e.trail[j].alpha -= WAVE_TRAIL_DECAY;
            if (e.trail[j].alpha <= 0) e.trail.splice(j, 1);
        }

        if (e.hit) {
            if (e.trail.length === 0) effects.splice(i, 1);
            continue;
        }

        if (waveFrames) {
            e.trail.push({
                x: e.x,
                y: e.y,
                frameIdx: Math.floor(e.age / 4) % waveFrames.length,
                alpha: 0.65
            });
        }

        e.age++;

        if (e.target.spared) {
            const next = activeEnemies()[0];
            if (!next) {
                if (e.trail.length === 0) effects.splice(i, 1);
                else e.hit = true;
                continue;
            }
            e.target = next;
        }

        const c = enemyCenter(e.target);
        e.angle = Math.atan2(c.y - e.y, c.x - e.x);
        e.speed = Math.min(9, e.speed + 0.75);
        e.x += Math.cos(e.angle) * e.speed;
        e.y += Math.sin(e.angle) * e.speed;

        if (Math.hypot(c.x - e.x, c.y - e.y) <= Math.max(e.speed, 14) || e.age >= WAVE_MAX_LIFE) {
            e.hit = true;
            if (e.onHit) e.onHit(e.target);
            spawnPerfectStars(c.x, c.y);
        }
    }
}

let waveSheet = null, waveFrames = null;
function getWaveSheet() {
    const img = susieSheet.img;
    if (waveSheet || !img.complete || !img.naturalWidth) return waveSheet || null;
    const rX = img.naturalWidth / SPRITE_CONFIGS.susie.refW;
    const rY = img.naturalHeight / SPRITE_CONFIGS.susie.refH;
    try {
        const off = document.createElement('canvas');
        off.width = img.naturalWidth; off.height = img.naturalHeight;
        const octx = off.getContext('2d', { willReadFrequently: true });
        octx.drawImage(img, 0, 0);

        const bx = Math.round(WAVE_BAND.x0 * rX), by = Math.round(WAVE_BAND.y0 * rY);
        const bw = Math.round((WAVE_BAND.x1 - WAVE_BAND.x0) * rX);
        const bh = Math.round((WAVE_BAND.y1 - WAVE_BAND.y0) * rY);
        const band = octx.getImageData(bx, by, bw, bh);
        const d = band.data;
        for (let i = 0; i < d.length; i += 4) {
            if (d[i + 3] < 8 || Math.hypot(d[i] - 138, d[i + 1] - 90, d[i + 2] - 157) < WAVE_KEY_TOLERANCE) d[i + 3] = 0;
        }
        octx.putImageData(band, bx, by);

        const occ = new Array(bw).fill(false);
        for (let x = 0; x < bw; x++)
            for (let y = 0; y < bh; y++)
                if (d[(y * bw + x) * 4 + 3] > 0) { occ[x] = true; break; }

        const runs = [];
        let start = -1, gap = 0;
        for (let x = 0; x <= bw; x++) {
            if (x < bw && occ[x]) { if (start < 0) start = x; gap = 0; }
            else if (start >= 0 && (++gap >= 2 || x === bw)) {
                const end = x - gap;
                if (end - start + 1 >= 6) runs.push([start, end]);
                start = -1; gap = 0;
            }
        }

        if (runs.length !== 14) throw new Error(`found ${runs.length} wave frames, expected 14`);

        waveFrames = runs.map(([x0, x1]) => {
            let y0 = bh, y1 = -1;
            for (let x = x0; x <= x1; x++)
                for (let y = 0; y < bh; y++)
                    if (d[(y * bw + x) * 4 + 3] > 0) { if (y < y0) y0 = y; if (y > y1) y1 = y; }
            return { sx: bx + x0, sy: by + y0, sw: x1 - x0 + 1, sh: y1 - y0 + 1 };
        });
        waveSheet = off;
    } catch (err) {
        waveSheet = img;
        waveFrames = SUSIE_WAVE.map(f => ({
            sx: Math.round(f[0] * rX), sy: Math.round(f[1] * rY),
            sw: Math.round((f[2] - 3) * rX), sh: Math.round(f[3] * rY)
        }));
    }
    return waveSheet;
}

function drawEffects() {
    const sheet = getWaveSheet();
    if (!sheet || !waveFrames) return;
    ctx.imageSmoothingEnabled = false;
    const S = SPRITE_SCALE;

    effects.forEach(e => {
        if (e.delay > 0) return;

        e.trail.forEach(t => {
            const tf = waveFrames[t.frameIdx];
            ctx.save();
            ctx.globalAlpha = Math.max(0, t.alpha);
            ctx.drawImage(
                sheet,
                tf.sx, tf.sy, tf.sw, tf.sh,
                Math.round(t.x - tf.sw * S / 2),
                Math.round(t.y - tf.sh * S / 2),
                tf.sw * S, tf.sh * S
            );
            ctx.restore();
        });

        if (!e.hit) {
            const f = waveFrames[Math.floor(e.age / 4) % waveFrames.length];
            ctx.drawImage(
                sheet,
                f.sx, f.sy, f.sw, f.sh,
                Math.round(e.x - f.sw * S / 2),
                Math.round(e.y - f.sh * S / 2),
                f.sw * S, f.sh * S
            );
        }
    });
}

// --- Update loop ---
function update() {
    updateBackground();
    updateParticles();
    updateAnimations();
    updateEffects();
    if (muteNoticeFrames > 0) muteNoticeFrames--;

    if (delayed) {
        if (--delayed.frames <= 0) {
            const fn = delayed.fn;
            delayed = null;
            fn();
        }
        return;
    }

    switch (currentState) {
        case STATES.EXECUTE_TURNS:  updateExecution();     break;
        case STATES.ATTACK_BAR:     updateAttackTracks();  break;
        case STATES.ENEMY_DIALOGUE: updateEnemyDialogue(); break;
        case STATES.ENEMY_TURN:     updateEnemyTurn();     break;
    }
}

// --- Rendering ---
function drawHeart(cx, cy, r, color) {
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.moveTo(cx, cy + r);
    ctx.bezierCurveTo(cx - r * 1.6, cy - r * 0.2, cx - r * 0.9, cy - r * 1.3, cx, cy - r * 0.4);
    ctx.bezierCurveTo(cx + r * 0.9, cy - r * 1.3, cx + r * 1.6, cy - r * 0.2, cx, cy + r);
    ctx.fill();
}

function drawWrapped(text, x, y, maxW, lineH) {
    let line = '';
    text.split(' ').forEach(word => {
        const test = line ? line + ' ' + word : word;
        if (ctx.measureText(test).width > maxW && line) {
            ctx.fillText(line, x, y);
            y += lineH;
            line = word;
        } else {
            line = test;
        }
    });
    ctx.fillText(line, x, y);
}

function enemyNameColor(e) {
    if (e.mercy >= 100) return '#ffff00';
    if (e.tired) return '#8888ff';
    return '#ffffff';
}

function drawTPMeter() {
    const x = 35, y = 30, width = 24, height = 150, skew = 12;
    ctx.fillStyle = '#660000';
    ctx.beginPath();
    ctx.moveTo(x + skew, y); ctx.lineTo(x + width + skew, y);
    ctx.lineTo(x + width, y + height); ctx.lineTo(x, y + height);
    ctx.closePath(); ctx.fill();

    if (tensionPoints > 0) {
        const fillHeight = (tensionPoints / 100) * height;
        ctx.fillStyle = tensionPoints >= 100 ? '#ffff00' : '#ff6600';
        ctx.beginPath();
        ctx.moveTo(x + skew, y + (height - fillHeight));
        ctx.lineTo(x + width + skew, y + (height - fillHeight));
        ctx.lineTo(x + width, y + height);
        ctx.lineTo(x, y + height);
        ctx.closePath(); ctx.fill();
    }

    ctx.fillStyle = '#ffffff';
    ctx.font = `bold 16px ${FONT_FAMILY}`;
    ctx.fillText('T', x - 25, y + 40);
    ctx.fillText('P', x - 25, y + 60);
    ctx.fillText(tensionPoints >= 100 ? 'MAX' : `${Math.floor(tensionPoints)}%`, x - 25, y + 100);
}

function drawSprites() {
    party.forEach((p, i) => {
        const feetY = PARTY_FEET_Y[i];
        if (SPRITE_CONFIGS[p.id] && drawMemberSprite(p, PARTY_X, feetY)) return;
        ctx.fillStyle = p.downed ? '#444444' : p.color;
        ctx.fillRect(PARTY_X - 15, feetY - 64, 30, 64);
    });

    enemies.forEach(e => {
        if (e.spared) return;
        if (e.asset && e.builtAnims && e.anim) {
            const def = e.builtAnims[e.anim.name];
            const frameIdx = def ? def.indices[e.anim.idx] : 0;
            const fc = e.asset.frames[frameIdx].canvas;
            const S = e.scale || 2;
            ctx.imageSmoothingEnabled = false;
            ctx.drawImage(fc, Math.round(e.x), Math.round(e.y), fc.width * S, fc.height * S);
        } else {
            ctx.fillStyle = e.tired ? '#8888ff' : (e.mercy >= 100 ? '#ffff00' : '#00ff77');
            ctx.fillRect(e.x, e.y, 40, 40);
        }
        ctx.fillStyle = enemyNameColor(e);
        ctx.font = `14px ${FONT_FAMILY}`;
        ctx.fillText(e.name, e.x - 5, e.y - 8);
    });
}

function drawPartyUI() {
    const startY = 280;
    ctx.fillStyle = '#000000';
    ctx.fillRect(0, startY, V_WIDTH, 80);

    party.forEach((member, i) => {
        const pX = 2 + i * 210;
        const choosing = currentState === STATES.ACTION_SELECT || currentState === STATES.SUB_MENU;
        const isActive = choosing && i === currentPartyIndex;

        if (isActive) {
            ctx.strokeStyle = member.color;
            ctx.lineWidth = 2;
            ctx.strokeRect(pX, startY + 2, 204, 74);
        }

        if (currentState === STATES.ENEMY_TURN && !member.downed &&
            enemies.some(e => !e.spared && e.target === member)) {
            ctx.strokeStyle = '#ffffff';
            ctx.lineWidth = 2;
            ctx.strokeRect(pX, startY + 2, 204, 74);
            ctx.fillStyle = '#ffffff';
            ctx.font = `bold 12px ${FONT_FAMILY}`;
            ctx.fillText('TARGET', pX + 4, startY - 4);
        }

        ctx.fillStyle = member.downed ? '#ff0000' : member.color;
        ctx.fillRect(pX + 8, startY + 8, 20, 20);

        ctx.fillStyle = '#ffffff';
        ctx.font = `bold 14px ${FONT_FAMILY}`;
        ctx.fillText(member.name, pX + 32, startY + 22);
        ctx.fillText(member.downed ? 'DOWN' : `${member.hp}/${member.maxHp}`, pX + 130, startY + 20);

        ctx.fillStyle = '#800000';
        ctx.fillRect(pX + 120, startY + 24, 70, 8);
        ctx.fillStyle = member.color;
        ctx.fillRect(pX + 120, startY + 24, (Math.max(0, member.hp) / member.maxHp) * 70, 8);

        if (isActive) {
            const actions = ACTIONS_BY_MEMBER[member.id];
            actions.forEach((act, a) => {
                const btnX = pX + 8 + a * 38, btnY = startY + 36;
                const isSelected = a === selectedAction;
                ctx.fillStyle = isSelected ? '#331100' : '#000000';
                ctx.fillRect(btnX, btnY, 32, 28);
                ctx.strokeStyle = isSelected ? '#ffff00' : '#d16000';
                ctx.lineWidth = 2;
                ctx.strokeRect(btnX, btnY, 32, 28);
                ctx.fillStyle = '#ff9900';
                ctx.font = `bold 14px ${FONT_FAMILY}`;
                ctx.fillText(ACTION_ICONS[act], btnX + 12, btnY + 18);
            });
        } else {
            const cmd = queuedCommands.find(c => c.member === member);
            if (cmd) {
                ctx.fillStyle = '#ff9900';
                ctx.font = `bold 14px ${FONT_FAMILY}`;
                ctx.fillText(cmd.action, pX + 32, startY + 52);
            } else if (member.downed) {
                ctx.fillStyle = '#888888';
                ctx.font = `14px ${FONT_FAMILY}`;
                ctx.fillText('Down...', pX + 32, startY + 52);
            }
        }
    });
}

function drawDialogueArea() {
    const y = 370;
    ctx.fillStyle = '#000000';
    ctx.fillRect(0, y, V_WIDTH, V_HEIGHT - y);
    if (currentState === STATES.ENEMY_TURN || currentState === STATES.ENEMY_DIALOGUE) return;

    ctx.font = `bold 20px ${FONT_FAMILY}`;

    if (currentState === STATES.SUB_MENU && menu) {
        const opts = menuOptions();
        opts.forEach((opt, i) => {
            const rowY = y + 32 + i * 24;
            if (i === menu.index) drawHeart(34, rowY - 6, 5, '#ff0000');
            ctx.fillStyle = opt.enabled === false ? '#666666'
                          : opt.enemy ? enemyNameColor(opt.enemy) : '#ffffff';
            ctx.fillText(`* ${opt.label}`, 48, rowY);
            if (opt.extra) {
                ctx.font = `14px ${FONT_FAMILY}`;
                ctx.fillStyle = opt.enabled === false ? '#666666' : '#cccccc';
                ctx.fillText(opt.extra, 260, rowY);
                ctx.font = `bold 20px ${FONT_FAMILY}`;
            }
        });
    } else {
        ctx.fillStyle = '#ffffff';
        drawWrapped(flavorText, 25, y + 35, V_WIDTH - 50, 26);
    }
}

function drawSpeechBubble() {
    if (!pendingDialogue) return;
    const sp = pendingDialogue.speaker;
    const bw = 175, bh = 86;
    const bx = Math.max(180, (sp ? sp.x : 470) - bw - 18);
    const by = Math.max(20, (sp ? sp.y : 80));

    // White rounded speech bubble with tail pointing right toward the boss
    ctx.fillStyle = '#ffffff';
    ctx.strokeStyle = '#000000';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.roundRect(bx, by, bw, bh, 10);
    ctx.fill();
    ctx.stroke();

    ctx.beginPath();
    ctx.moveTo(bx + bw - 1, by + 24);
    ctx.lineTo(bx + bw + 14, by + 32);
    ctx.lineTo(bx + bw - 1, by + 42);
    ctx.closePath();
    ctx.fill();

    ctx.fillStyle = '#000000';
    ctx.font = `bold 13px ${FONT_FAMILY}`;
    const visible = pendingDialogue.text.slice(0, Math.floor(dialogueCharCount));
    drawWrapped(visible, bx + 10, by + 20, bw - 20, 17);
}

function drawAttackBar() {
    const barY = 370;
    ctx.fillStyle = '#111111';
    ctx.fillRect(100, barY, 440, 75);
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 2;
    ctx.strokeRect(100, barY, 440, 75);

    ctx.fillStyle = '#ff0000';
    ctx.fillRect(TARGET_LINE_X, barY, 4, 75);

    attackTracks.forEach(t => {
        if (!t.active) return;
        ctx.fillStyle = t.color;
        ctx.fillRect(t.x, t.trackY, 8, 18);
        ctx.fillStyle = '#000000';
        ctx.font = `bold 12px ${FONT_FAMILY}`;
        ctx.fillText(t.member.name[0], t.x + 1, t.trackY + 13);
    });
}

function drawStars() {
    ctx.fillStyle = '#ffff00';
    starParticles.forEach(p => ctx.fillRect(p.x, p.y, 4, 4));
}

function drawBattleArena() {
    // With a screen-wide soul there is no box to draw
    if (currentState === STATES.ENEMY_TURN && activeAttack && activeAttack.freeSoul) {
        drawAdvancedAttack();
        drawSoul();
        return;
    }
    ctx.fillStyle = '#000000';
    ctx.fillRect(arena.x, arena.y, arena.w, arena.h);

    // Draw active GIF/image attack clipped inside the battle box
    if (currentState === STATES.ENEMY_TURN && activeAttack && !activeAttack.advanced && activeAttack.asset && activeAttack.asset.frames.length > 0) {
        const frames = activeAttack.asset.frames;
        const fc = frames[activeAttack.frameIdx % frames.length].canvas;
        ctx.save();
        ctx.beginPath();
        ctx.rect(arena.x, arena.y, arena.w, arena.h);
        ctx.clip();
        ctx.imageSmoothingEnabled = false;
        ctx.drawImage(fc, arena.x, arena.y, arena.w, arena.h);
        ctx.restore();
    }

    ctx.strokeStyle = '#00ff00';
    ctx.lineWidth = 4;
    ctx.strokeRect(arena.x, arena.y, arena.w, arena.h);

    if (currentState !== STATES.ENEMY_TURN) return;

    if (activeAttack && activeAttack.advanced) drawAdvancedAttack();
    if (activeAttack && activeAttack.error) {
        ctx.fillStyle = '#ffff00';
        ctx.font = `14px ${FONT_FAMILY}`;
        ctx.fillText(`ADVANCED ATTACK ERROR: ${activeAttack.error}`, 20, 392);
    }

    bullets.forEach(b => {
        ctx.fillStyle = '#ffffff';
        ctx.beginPath();
        ctx.arc(b.x, b.y, b.size, 0, Math.PI * 2);
        ctx.fill();
    });

    drawSoul();
}

function drawAdvancedAttack() {
    const frames = activeAttack.asset.frames;
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(frames[activeAttack.frameIdx % frames.length].canvas, 0, 0, V_WIDTH, V_HEIGHT);
}

function drawSoul() {
    if (soulGrazing) {
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.arc(soul.x, soul.y, 13, 0, Math.PI * 2);
        ctx.stroke();
    }
    if (soulInvuln <= 0 || soulInvuln % 16 < 8) drawHeart(soul.x, soul.y, 7, '#ff0000');
}

function render() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    ctx.save();
    ctx.translate(offsetX, offsetY);
    ctx.scale(scale, scale);

    drawBackground();
    drawTPMeter();
    drawSprites();
    drawPartyUI();

    if (currentState === STATES.ENEMY_TURN) {
        drawDialogueArea();
        drawBattleArena();
    } else if (currentState === STATES.ENEMY_DIALOGUE) {
        drawDialogueArea();
        drawBattleArena();
        drawSpeechBubble();
    } else if (currentState === STATES.ATTACK_BAR && attackTracks.some(t => t.active)) {
        drawAttackBar();
    } else {
        drawDialogueArea();
    }
    drawStars();
    drawEffects();
    if (muteNoticeFrames > 0) {
        ctx.fillStyle = '#ffff00';
        ctx.font = `14px ${FONT_FAMILY}`;
        ctx.fillText(audioPrefs.muted ? 'SOUND OFF (M)' : 'SOUND ON (M)', 270, 16);
    }

    ctx.restore();
}

// ============================================================================
// SERVERLESS MOD FOLDER LOADER (DRAG & DROP + TOP-RIGHT BUTTON)
// ============================================================================
const README_URL = 'https://github.com/TheBenAtor/thebenator.github.io';
// Relative on purpose: resolves to https://thebenator.github.io/editor/ when hosted, and works on local servers too.
const EDITOR_URL = 'editor/';

// Top-right toolbar: README + EDITOR + LOAD MOD. Only created when no encounter was auto-loaded.
function createToolbarButtons(applyFiles) {
    const input = document.createElement('input');
    input.type = 'file';
    input.webkitdirectory = true;
    input.multiple = true;
    input.style.display = 'none';
    document.body.appendChild(input);
    input.onchange = e => { if (e.target.files.length) applyFiles(e.target.files); };

    const bar = document.createElement('div');
    Object.assign(bar.style, {
        position: 'fixed', top: '8px', right: '8px', zIndex: '999',
        display: 'flex', gap: '6px'
    });

    const makeBtn = (label, onclick) => {
        const btn = document.createElement('button');
        btn.textContent = label;
        Object.assign(btn.style, {
            background: '#111', color: '#888', border: '1px solid #333',
            fontFamily: FONT_FAMILY, fontSize: '11px', padding: '4px 8px', cursor: 'pointer'
        });
        btn.onmouseenter = () => { btn.style.color = '#ffff00'; btn.style.borderColor = '#ffff00'; };
        btn.onmouseleave = () => { btn.style.color = '#888'; btn.style.borderColor = '#333'; };
        btn.onclick = onclick;
        bar.appendChild(btn);
        return btn;
    };

    makeBtn('README', () => window.open(README_URL, '_blank', 'noopener'));
    makeBtn('EDITOR', () => window.open(EDITOR_URL, '_blank', 'noopener'));
    makeBtn('LOAD MOD', () => input.click());
    document.body.appendChild(bar);
}

function setupModLoaderUI(showButtons = true) {
    const applyFiles = async (files) => {
        const iniFile = registerModFileList(files);
        if (!iniFile) {
            alert('No encounter.ini or encounter.txt found in the selected folder.');
            return;
        }
        const text = await iniFile.text();
        loadedModConfig = parseEncounterIni(text);
        initBattle();
    };

    if (showButtons) createToolbarButtons(applyFiles);

    // Drag-and-drop a mod folder or files onto the game window
    window.addEventListener('dragover', e => e.preventDefault());
    window.addEventListener('drop', async e => {
        e.preventDefault();
        const items = e.dataTransfer && e.dataTransfer.items;
        if (!items) return;

        // The item list is only valid synchronously, so grab every entry BEFORE any await.
        const entries = [];
        for (const item of items) {
            const entry = item.webkitGetAsEntry && item.webkitGetAsEntry();
            if (entry) entries.push(entry);
        }

        // readEntries() returns at most ~100 entries per call; loop until empty.
        const readAllEntries = async (reader) => {
            const all = [];
            while (true) {
                const batch = await new Promise((res, rej) => reader.readEntries(res, rej));
                if (batch.length === 0) break;
                all.push(...batch);
            }
            return all;
        };

        const collected = [];
        const walkEntry = async (entry, prefix = '') => {
            if (entry.isFile) {
                const file = await new Promise((res, rej) => entry.file(res, rej));
                Object.defineProperty(file, 'webkitRelativePath', { value: prefix + file.name });
                collected.push(file);
            } else if (entry.isDirectory) {
                const children = await readAllEntries(entry.createReader());
                for (const child of children) await walkEntry(child, prefix + entry.name + '/');
            }
        };

        for (const entry of entries) await walkEntry(entry);
        if (collected.length > 0) applyFiles(collected);
    });
}

async function tryAutoLoadDefaultIni() {
    for (const candidate of ['encounter.ini', 'encounter.txt']) {
        try {
            const res = await fetch(MOD_BASE + candidate);
            if (!res.ok) continue;
            const text = await res.text();
            if (/^\s*</.test(text)) continue; // a server returned an HTML page instead of the file
            loadedModConfig = parseEncounterIni(text);
            return true;
        } catch (_) {
            // Running via file:// without a server; fall back to built-in battle
        }
    }
    return false;
}

// Fixed 60 Hz logic step
const STEP_MS = 1000 / 60;
let lastTime = 0, accumulator = 0;
function frame(now) {
    accumulator += Math.min(now - lastTime, 100);
    lastTime = now;
    while (accumulator >= STEP_MS) {
        update();
        accumulator -= STEP_MS;
    }
    render();
    requestAnimationFrame(frame);
}

Promise.all([
    tryAutoLoadDefaultIni().catch(() => false),
    loadDefaultBackground()
]).then(([autoLoaded]) => {
    // A mod that ships with the page (auto-loaded encounter.ini) hides the README / EDITOR / LOAD MOD buttons.
    setupModLoaderUI(!autoLoaded);
    initBattle();
    // Font lives in GAME/ASSETS/fonts and is declared with @font-face in index.html.
    Promise.resolve(document.fonts.load(`bold 16px ${FONT_FAMILY}`)).catch(() => {})
        .then(() => document.fonts.ready)
        .then(() => {
            lastTime = performance.now();
            requestAnimationFrame(frame);
        });
});

// ============================================================================
// MOBILE FLOATING 8-WAY JOYSTICK & Z/X/C CONTROLS
// ============================================================================
(function initMobileControls() {
    // Only show on touch-capable devices (remove this check if testing on desktop mouse)
    const isTouchDevice = ('ontouchstart' in window) || (navigator.maxTouchPoints > 0);
    if (!isTouchDevice) return;

    // Helper to trigger your engine's exact keydown/keyup logic and keys[] state
    function setVirtualKey(key, isDown) {
        const k = key.toLowerCase();
        if (Boolean(keys[k]) === isDown) return; // Avoid duplicate spam
        keys[k] = isDown;
        window.dispatchEvent(new KeyboardEvent(isDown ? 'keydown' : 'keyup', {
            key: key,
            bubbles: true
        }));
    }

    // 1. Floating Joystick Elements (Left Side)
    const joyZone = document.createElement('div');
    Object.assign(joyZone.style, {
        position: 'fixed', left: '0', top: '0', width: '55vw', height: '100vh',
        zIndex: '900', touchAction: 'none'
    });

    const joyBase = document.createElement('div');
    Object.assign(joyBase.style, {
        position: 'fixed', width: '110px', height: '110px', borderRadius: '50%',
        border: '2px solid rgba(255, 255, 255, 0.5)',
        background: 'rgba(0, 0, 0, 0.35)',
        display: 'none', pointerEvents: 'none', zIndex: '901',
        transform: 'translate(-50%, -50%)'
    });

    const joyNub = document.createElement('div');
    Object.assign(joyNub.style, {
        position: 'absolute', left: '50%', top: '50%',
        width: '44px', height: '44px', borderRadius: '50%',
        background: 'rgba(255, 0, 0, 0.85)', // Deltarune SOUL red
        border: '2px solid #ffffff',
        transform: 'translate(-50%, -50%)'
    });
    joyBase.appendChild(joyNub);
    document.body.appendChild(joyZone);
    document.body.appendChild(joyBase);

    let joyPointerId = null;
    let originX = 0, originY = 0;
    const maxRadius = 38;
    const deadzone = 12;

    function updateDpadFromAngle(dx, dy, dist) {
        let up = false, down = false, left = false, right = false;

        if (dist >= deadzone) {
            const deg = (Math.atan2(dy, dx) * (180 / Math.PI) + 360) % 360;
            if (deg >= 337.5 || deg < 22.5)        { right = true; }
            else if (deg >= 22.5 && deg < 67.5)    { right = true; down = true; }
            else if (deg >= 67.5 && deg < 112.5)   { down = true; }
            else if (deg >= 112.5 && deg < 157.5)  { down = true; left = true; }
            else if (deg >= 157.5 && deg < 202.5)  { left = true; }
            else if (deg >= 202.5 && deg < 247.5)  { left = true; up = true; }
            else if (deg >= 247.5 && deg < 292.5)  { up = true; }
            else if (deg >= 292.5 && deg < 337.5)  { up = true; right = true; }
        }

        setVirtualKey('ArrowUp', up);
        setVirtualKey('ArrowDown', down);
        setVirtualKey('ArrowLeft', left);
        setVirtualKey('ArrowRight', right);
    }

    joyZone.addEventListener('pointerdown', (e) => {
        if (joyPointerId !== null) return;
        joyPointerId = e.pointerId;
        joyZone.setPointerCapture(e.pointerId);

        originX = e.clientX;
        originY = e.clientY;
        joyBase.style.left = `${originX}px`;
        joyBase.style.top = `${originY}px`;
        joyBase.style.display = 'block';
        joyNub.style.transform = 'translate(-50%, -50%)';
    });

    joyZone.addEventListener('pointermove', (e) => {
        if (e.pointerId !== joyPointerId) return;
        const dx = e.clientX - originX;
        const dy = e.clientY - originY;
        const dist = Math.hypot(dx, dy);
        const angle = Math.atan2(dy, dx);

        const clamped = Math.min(dist, maxRadius);
        const nx = Math.cos(angle) * clamped;
        const ny = Math.sin(angle) * clamped;
        joyNub.style.transform = `translate(calc(-50% + ${nx}px), calc(-50% + ${ny}px))`;

        updateDpadFromAngle(dx, dy, dist);
    });

    const releaseJoystick = (e) => {
        if (e.pointerId !== joyPointerId) return;
        joyPointerId = null;
        joyBase.style.display = 'none';
        updateDpadFromAngle(0, 0, 0);
    };
    joyZone.addEventListener('pointerup', releaseJoystick);
    joyZone.addEventListener('pointercancel', releaseJoystick);

    // 2. Z / X / C Action Buttons (Bottom-Right)
    const btnContainer = document.createElement('div');
    Object.assign(btnContainer.style, {
        position: 'fixed', right: '20px', bottom: '24px',
        display: 'flex', gap: '12px', alignItems: 'flex-end',
        zIndex: '910', touchAction: 'none'
    });

    function createActionButton(label, keyName, size, borderColor) {
        const btn = document.createElement('div');
        btn.textContent = label;
        Object.assign(btn.style, {
            width: `${size}px`, height: `${size}px`, borderRadius: '50%',
            background: 'rgba(0, 0, 0, 0.55)',
            border: `2px solid ${borderColor}`,
            color: borderColor,
            fontFamily: FONT_FAMILY, fontSize: `${Math.round(size * 0.36)}px`,
            fontWeight: 'bold', display: 'flex', alignItems: 'center',
            justifyContent: 'center', touchAction: 'none', userSelect: 'none'
        });

        let btnPointer = null;
        btn.addEventListener('pointerdown', (e) => {
            e.preventDefault();
            e.stopPropagation();
            if (btnPointer !== null) return;
            btnPointer = e.pointerId;
            btn.setPointerCapture(e.pointerId);
            btn.style.background = 'rgba(255, 255, 255, 0.25)';
            setVirtualKey(keyName, true);
        });

        const releaseBtn = (e) => {
            if (e.pointerId !== btnPointer) return;
            btnPointer = null;
            btn.style.background = 'rgba(0, 0, 0, 0.55)';
            setVirtualKey(keyName, false);
        };
        btn.addEventListener('pointerup', releaseBtn);
        btn.addEventListener('pointercancel', releaseBtn);

        return btn;
    }

    // C (Menu/Extra), X (Cancel / Slow SOUL), Z (Confirm / Attack)
    const btnC = createActionButton('C', 'c', 46, '#00ff21');
    const btnX = createActionButton('X', 'x', 54, '#00ffff');
    const btnZ = createActionButton('Z', 'z', 64, '#ffff00');

    btnContainer.appendChild(btnC);
    btnContainer.appendChild(btnX);
    btnContainer.appendChild(btnZ);
    document.body.appendChild(btnContainer);
})();
