# Battle Engine — Mod & Fight Creation Guide

A canvas-based, turn-based battle engine in the style of Deltarune. A fight is built from **one text file** (`encounter.ini`) plus **image/GIF assets**. You don't need to touch `GAME/script.js` to make a fight.

The player controls **Kris, Susie and Ralsei**. Enemies attack by playing a **GIF (or image) inside the battle box**. Any pixel of the right color in the current frame hurts the player's soul, so you can draw bullet patterns in any animation program. **The battle box automatically resizes to match each attack's GIF**, so the size you draw is the size you fight in.

---

## Table of contents

1. [Quick start](#1-quick-start)
2. [Project and mod layout](#2-project-and-mod-layout)
3. [How a battle plays out](#3-how-a-battle-plays-out)
4. [INI syntax rules](#4-ini-syntax-rules)
5. [Section reference](#5-section-reference)
   - [`[ARENA]`](#arena)
   - [`[BATTLE]`](#battle)
   - [`[PARTY_*]`](#party_name)
   - [`[ENEMY]` / `[BOSS]`](#enemy--boss)
   - [`[ENEMY_ANIM:name]`](#enemy_animname)
   - [`[ACT:Name]`](#actname)
   - [`[PHASE_n]`](#phase_n)
   - [`[ATTACKS]` and `[PHASE_n_ATTACKS]`](#attacks-and-phase_n_attacks)
   - [`[ATTACK:name]` / `[GIF:name]`](#attackname--gifname)
6. [Making attack GIFs](#6-making-attack-gifs)
7. [Making enemy sprites](#7-making-enemy-sprites)
8. [Phases and dialogue](#8-phases-and-dialogue)
9. [Combat rules cheat-sheet](#9-combat-rules-cheat-sheet)
10. [Full example encounter](#10-full-example-encounter)
11. [Testing and debugging](#11-testing-and-debugging)
12. [Troubleshooting](#12-troubleshooting)
13. [Limits and what's hard-coded](#13-limits-and-whats-hard-coded)

---

## 1. Quick start

### Repository layout

```
root/
├─ index.html
├─ README.md
├─ editor/
│  └─ index.html            <- the web fight editor (thebenator.github.io/editor)
├─ GAME/                    <- the engine (you don't edit this to make a fight)
│  ├─ script.js
│  └─ ASSETS/               <- base game assets
│     ├─ kris-sheet.jpg
│     ├─ rals-sheet.png
│     ├─ susie-sheet.png
│     └─ fonts/             <- optional font files (e.g. Determination.ttf)
└─ MOD/                     <- the fight (the only folder you change)
   ├─ encounter.ini
   ├─ ENEMY/                <- enemy sprites
   └─ ATTACKS/              <- attack GIFs and _stripN.png files
```

- **`GAME/`** is the engine and its base assets. It contains the party sprite sheets and fonts, which mods cannot replace.
- **`MOD/`** is your fight. To make a new fight you only ever edit or replace this folder.

### Host page

`index.html` sits in the root and needs a canvas with the id `gameCanvas`, loading `GAME/script.js` at the end of the body:

```html
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>Battle</title>
  <style>
    /* Optional font: put the file in GAME/ASSETS/fonts/ and uncomment.
    @font-face {
      font-family: "Determination";
      src: url("GAME/ASSETS/fonts/Determination.ttf") format("truetype");
    }
    */
    html, body { margin: 0; height: 100%; background: #000; overflow: hidden; }
    canvas { display: block; }
  </style>
</head>
<body>
  <canvas id="gameCanvas"></canvas>
  <script src="GAME/script.js"></script>
</body>
</html>
```

All engine paths are relative to `index.html`, so keep it in the root.

The party sprite sheets (`kris-sheet.jpg`, `rals-sheet.png`, `susie-sheet.png`) go in `GAME/ASSETS/`. Party sprites are **not** loaded from the mod folder. If a sheet is missing, that member is drawn as a colored rectangle and the game still works.

The engine uses the font `Determination` and falls back to `monospace`. For the real look, add the font file under `GAME/ASSETS/fonts/` and enable the `@font-face` block above.

### Three ways to load a fight

| Method | How |
|---|---|
| **Auto-load** | Put `encounter.ini` (or `encounter.txt`) in the `MOD` folder and serve the site. It is loaded at startup. This is how you publish a fight. |
| **LOAD MOD button** | Click the small `LOAD MOD` button (top-right) and pick a mod folder (the folder that **contains** `encounter.ini`, such as `MOD`). |
| **Drag and drop** | Drag a mod folder onto the game window. |

The top-right corner has three small buttons: **README** (opens this guide on GitHub in a new tab), **EDITOR** (opens the [fight editor](#fight-editor) in a new tab) and **LOAD MOD**. **If a mod is auto-loaded, all three buttons are hidden**, so a published fight shows only the game. Drag-and-drop still works either way, which is handy for testing a different mod over a published one.

**Browsers block `fetch` and pixel reads on `file://` pages.** Opening `index.html` by double-clicking won't auto-load `MOD/`, and attack-GIF collision will fail (the canvas becomes tainted). Either use LOAD MOD or drag-and-drop (these always work), or run a local server from the project root:

```bash
python3 -m http.server 8000
# then open http://localhost:8000
```

### Fight editor

Don't want to write the INI by hand? Use the web editor at **[thebenator.github.io/editor](https://thebenator.github.io/editor)**, or click **EDITOR** in the game's top-right corner. It is one self-contained page (`editor/index.html`) with a form for every section in this guide (enemies, animations, ACTs, phases, attack sequences and attack settings) and a live `encounter.ini` preview.

- **Open folder (edit)** (Chrome / Edge): pick your `MOD` folder (or the project root) and allow access. The editor loads `encounter.ini`, previews your sprites and attack images, and **Save to folder** (or `Ctrl`/`Cmd`+`S`) writes `encounter.ini` straight back. The first save of a session keeps the old file as `encounter.ini.bak`, because the editor rewrites the whole file and drops hand-written comments. There is an optional auto-save.
- **Load mod folder / Import INI / Download** work in any browser if you'd rather not grant write access.
- **Checks as you type:** it flags invalid phase triggers, empty attack turns, missing asset files, attack images outside the 48–580 × 48–245 box limits, sprite frames past the end of a sheet, dialogue over about 70 characters and the other pitfalls listed in [Troubleshooting](#12-troubleshooting).
- Drag an enemy on the preview screen to set its `x` / `y`, and play each named animation before you test in the game.

The editor does not draw attack GIFs. Make those in your animation program (see [Making attack GIFs](#6-making-attack-gifs)) and the editor will preview them and check their size.

If there is no `MOD/encounter.ini` and you load nothing, the engine runs a built-in demo with two enemies (Rudinn and Hathy) and simple aimed bullets.

The shipped `MOD/encounter.ini` is a minimal starter fight (one Test Dummy, no extra assets). Replace it with your own.

---

## 2. Project and mod layout

A mod is the `MOD` folder, laid out like this:

```
MOD/
├─ encounter.ini          <- required (or encounter.txt)
├─ ENEMY/
│  └─ warden_sheet.png    <- enemy sprite (sheet or GIF)
└─ ATTACKS/
   ├─ rain.gif            <- attack animations
   ├─ sweep.gif
   ├─ storm.gif
   └─ spiral_strip8.png   <- strip PNG attack
```

Enemy sprites go in `ENEMY/` and everything that plays inside the battle box (GIFs, `_stripN.png`, still images) goes in `ATTACKS/`.

### How the engine finds your config

- **Auto-load:** the engine fetches `MOD/encounter.ini`, then `MOD/encounter.txt`.
- **LOAD MOD / drag-and-drop:** it uses `encounter.ini` or `encounter.txt` if present. Otherwise it uses the first `.ini` / `.txt` file it finds.
- If a folder you load has no such file, you get an alert: *"No encounter.ini or encounter.txt found…"*

### How asset paths are resolved

Paths in the INI are relative to the **`MOD` folder**:

```ini
sprite = ENEMY/warden_sheet.png
file   = ATTACKS/storm.gif
```

You can also **leave out the folder name**. A bare file name is looked up in `ENEMY/` for enemy sprites and in `ATTACKS/` for attacks:

```ini
# same as ENEMY/warden_sheet.png
sprite = warden_sheet.png

# same as ATTACKS/rain.gif
1 = rain.gif
```

Sub-folders work too (`ATTACKS/phase2/storm.gif`).

Other rules:

- **Folder pick / drag-and-drop:** matching is **case-insensitive** and slash-insensitive. If the full path isn't found, the engine tries the **file name alone**, so `ATTACKS/rain.gif`, `rain.gif` and `RAIN.GIF` all work if there's only one `rain.gif` in the mod.
- Give files **unique names**, because the first file with a given name wins the fallback.
- **Auto-load over HTTP is case-sensitive on most hosts, including GitHub Pages.** Use the exact folder names `ENEMY` and `ATTACKS` (upper case) and match your file names exactly.

---

## 3. How a battle plays out

Each round has two halves.

**1. Player turn.** Each conscious party member picks a command in order (Kris, Susie, Ralsei). `X` / `Shift` cancels the previous member's command. Once everyone has chosen, commands run in this order:

1. DEFEND
2. ACT (including Susie's S-Action and Ralsei's R-Action)
3. MAGIC, SPARE, ITEM
4. FIGHT (the timing-bar minigame)

**2. Enemy turn.**

1. **Phase check.** The engine checks whether a [phase](#phase_n) should trigger.
2. **Attack pick.** It picks the attack for this turn from `[ATTACKS]` (or the active phase's attacks).
3. **Dialogue.** Any phase dialogue, then any attack dialogue, appears in a speech bubble while the battle box resizes.
4. **Dodge.** The attack GIF plays inside the box for `duration` frames while the player dodges.

Then the next round begins with a flavor line picked from the current flavor pool.

**Winning:** every enemy is spared or reduced to 0 HP. **Losing:** all three party members are down.
Press `Z` / `Enter` on the victory or game-over screen to restart.

**Controls**

| Key | Action |
|---|---|
| `Z` / `Enter` | Confirm, advance dialogue, hit the FIGHT bar |
| `X` / `Shift` | Cancel; skip dialogue typing; **slow the soul to half speed** during attacks |
| Arrows / `WASD` | Move the menu cursor / move the soul |

---

## 4. INI syntax rules

```ini
# Comment (a line that starts with # or ;)
; Also a comment

[SECTION_NAME]
key = value
```

- `[Section]` names are **case-insensitive**.
- Keys are mostly **case-sensitive**. Write them exactly as in this guide (`frameW`, `boss_anim`, `maxHp`). The exceptions are `loop`, `acts` and keys starting with `flavor`, which are case-insensitive.
- Values are trimmed. **Don't use quotes.** They would be shown literally.
- Only the first `=` splits a line, so values may contain `=`.
- Comments must be on their own line. There are **no inline comments**. `hp = 100 # boss` makes the value the string `100 # boss`.
- Values become `true`/`false`, a number, or a string automatically.
  - Don't make text that is *only* digits (for example `dialogue = 404`). It becomes a number and can break the text box. Add any non-digit character.
- Colors need the `#`: `color = #ff00ff`.
- Unknown sections and keys are silently ignored, so check the console if something has no effect.
- Sections can appear in any order, **except** that `[ENEMY_ANIM:…]` must come **after** the `[ENEMY]` it belongs to.

---

## 5. Section reference

### `[ARENA]`

The *fallback* size of the battle box (the green-bordered square where the soul moves). This section is optional.

| Key | Default | Meaning |
|---|---|---|
| `w` | `180` | Width in pixels |
| `h` | `150` | Height in pixels |

You normally never need this. During an attack the box **automatically takes the size of that attack's GIF** (see [Making attack GIFs](#6-making-attack-gifs)). `[ARENA]` is only used when an attack has no image (the built-in fallback bullets, or an image that failed to load).

The box is always centered horizontally on the 640×480 screen and vertically around y = 190.

> **Tip:** keep your GIF height at **180 or less**. Taller boxes overlap the party panel at the bottom. The box is clamped to 48–580 wide and 48–245 tall, and GIFs outside that range are scaled to fit.

---

### `[BATTLE]`

| Key | Default | Meaning |
|---|---|---|
| `victoryText` | `* YOU WON! Got 0 EXP and … D$. (Z to restart)` | Shown on victory |
| `gameOverText` | `* THE WORLD WAS COVERED IN DARKNESS. (Z to retry)` | Shown on game over |

Include `(Z to restart)` in custom text so players know how to continue.

---

### `[PARTY_<name>]`

Override a party member's stats. Valid names are `PARTY_KRIS`, `PARTY_SUSIE` and `PARTY_RALSEI`.

| Key | Kris | Susie | Ralsei | Meaning |
|---|---|---|---|---|
| `maxHp` | 90 | 110 | 70 | Maximum HP |
| `hp` | = maxHp | = maxHp | = maxHp | Starting HP |
| `power` | 35 | 50 | 25 | Attack stat (FIGHT and Rude Buster damage) |
| `def` | 0 | 0 | 0 | Subtracted from incoming damage (minimum 1) |
| `magic` | 0 | 10 | 20 | Scales Rude Buster (Susie) and Heal Prayer (Ralsei) |
| `color` | `#00ffff` | `#ff00ff` | `#00ff21` | UI color, hex with `#` |
| `name` | KRIS | SUSIE | RALSEI | Display name |

```ini
[PARTY_SUSIE]
maxHp = 130
power = 60
magic = 14
```

---

### `[ENEMY]` / `[BOSS]`

Both names are identical. **Repeat the section** to add several enemies. Each defines one enemy.

| Key | Default | Meaning |
|---|---|---|
| `name` | `Enemy` | Name shown above the sprite and in menus |
| `hp` | `100` | Max HP |
| `def` | `0` | Subtracted from damage dealt to it |
| `x`, `y` | `470`, `80` | **Top-left** of the sprite in the 640×480 screen |
| `scale` | `2` | Sprite scale multiplier |
| `sprite` | none | Path to a `.gif`, a sprite sheet, or a single image, relative to `MOD/` (a bare file name is looked up in `ENEMY/`) |
| `frameW`, `frameH` | whole image | Frame size for sprite sheets (see [Enemy sprites](#7-making-enemy-sprites)) |
| `fps` | `8` | Speed of the default idle loop for sheets |
| `acts` | `Check, Flatter` | Comma-separated list shown in Kris's ACT menu |
| `flavor` | `* An enemy draws near!` | Battle text lines. **Repeatable.** Any key starting with `flavor` works (`flavor1`, `flavor2`, …) |

The **first** `flavor` line is shown at the very start of the fight (use it as your intro). Afterwards a random line from the pool appears at the start of each player turn. Your own `flavor` lines replace the default one.

If you give no `sprite`, the enemy is drawn as a plain colored square (green normally, blue when tired, yellow when merciable).

Enemy name colors: **white** normal, **blue** tired, **yellow** mercy is 100%.

---

### `[ENEMY_ANIM:name]`

Defines a named animation for the **most recently declared** enemy. Put it right after that enemy's section.

| Key | Default | Meaning |
|---|---|---|
| `frames` | `0` | Which frames to play (see below) |
| `ticks` | `8` | Game ticks per frame. The game runs at 60 ticks/sec, so `ticks = 6` is 10 fps |
| `loop` | `true` | `false` plays once, then returns to `idle` |

`frames` accepts:

- a single number: `frames = 3`
- a list: `frames = 0,1,2,1`
- a range: `frames = 4-7`
- a mix: `frames = 0-3,5`

Frame numbers are **0-based**. Sprite sheets count left-to-right, then top-to-bottom. Out-of-range numbers are dropped.

Rules:

- **`idle` is special.** It plays by default. If you don't define it, the engine loops every frame.
- Any other name (`angry`, `attack`, `hurt` …) only plays when a phase or attack asks for it with `boss_anim`.
- A looping animation keeps looping until something replaces it. At the **end of every enemy turn** all enemies are reset to `idle`, so a looping `boss_anim` lasts for one turn at most.
- Use `loop = false` for one-shot animations like a swing or a flinch.

```ini
[ENEMY_ANIM:idle]
frames = 0-3
ticks = 10

[ENEMY_ANIM:angry]
frames = 4-7
ticks = 6
loop = false
```

---

### `[ACT:Name]`

Defines what an ACT does. The name is matched **case-insensitively** against the enemy's `acts` list. Only listed acts appear in the menu.

| Key | Default | Meaning |
|---|---|---|
| `mercy` | `50` | Mercy % added to the target. Use `0` for none. **Don't use negatives** |
| `tired` | `false` | `true` makes the enemy TIRED (blue name, which enables Pacify) |
| `text` | empty | Text shown while the action plays |

Details:

- An ACT with **no** `[ACT:]` section gives **+50 mercy**, except `Check`, which gives nothing.
- ACT definitions are **global**. Two enemies with an act named `Calm` share one definition.
- The text stays on screen about as long as the character's ACT animation (roughly one second), so keep it short. About 100 characters (two lines) is safe.
- Susie's **S-Action** and Ralsei's **R-Action** are built in and always give +25 mercy to an enemy.

```ini
[ACT:Check]
mercy = 0
text = * WARDEN - ATK 12 DEF 2. Hates loud noises.

[ACT:Calm]
mercy = 30
text = * You hum quietly. The flicker steadies.

[ACT:Taunt]
mercy = 0
tired = true
text = * You mock the Warden. It slumps, exhausted.
```

---

### `[PHASE_n]`

Boss phases. `n` is a whole number. Phase 1 is the starting phase. Higher phases fire from a trigger. Full details are in [Phases and dialogue](#8-phases-and-dialogue).

| Key | Meaning |
|---|---|
| `trigger` | When the phase starts (see below). Omit for phase 1 |
| `dialogue` | A line the boss says when the phase starts |
| `boss_anim` | Enemy animation to play when the phase starts |
| `flavor` | Repeatable. **Replaces** the enemy's flavor pool while this phase is active |

Trigger formats (case-insensitive):

| Trigger | Fires when |
|---|---|
| `hp_below:50%` | The enemy's HP is at or below 50% of max |
| `hp_below:120` | The enemy's HP is at or below 120 |
| `mercy_above:60` | The enemy's mercy is at or above 60% |
| `turn:4` | Four enemy turns have started |

Each phase fires once.

---

### `[ATTACKS]` and `[PHASE_n_ATTACKS]`

Define which attack plays on which enemy turn. `[ATTACKS]` is the global sequence, and `[PHASE_n_ATTACKS]` belongs to a phase and overrides the global one while that phase is active.

```ini
[PHASE_1_ATTACKS]
1 = rain.gif
2 = rain.gif, sweep.gif
3 = sweep.gif
loop = 2
```

- Each numbered key is a **turn number**. The value is a **comma-separated pool** and one entry is chosen at random. Curly braces are optional (`2 = {rain.gif, sweep.gif}`).
- Turn numbers count from the start of the current phase. The counter **resets to 1 every time a phase triggers**.
- `loop` says what happens after the last defined turn:
  - `loop = last` (default) repeats the final turn forever.
  - `loop = N` cycles turns N through the last one. With turns 1–3 and `loop = 2`, the order is 1, 2, 3, 2, 3, 2, 3…
- **Gaps:** a turn with no entry gets the built-in fallback aimed bullets. Define every turn from 1 to your last.
- A phase with no attacks section uses the global `[ATTACKS]`. If neither exists, the engine uses the built-in fallback bullets.
- Names are file paths or aliases (see below). Names can't contain commas.

---

### `[ATTACK:name]` / `[GIF:name]`

Optional settings for one attack. Both headers are identical. `name` is exactly what you write in the attack lists (matching is case-insensitive).

| Key | Default | Meaning |
|---|---|---|
| `file` | the name itself | Actual file path, relative to `MOD/` (a bare file name is looked up in `ATTACKS/`). Lets you use short aliases |
| `damage` | `18` | Damage per hit to the targeted party member |
| `duration` | `480` | Length in **frames at 60 fps** (480 = 8 seconds) |
| `fps` | the GIF's own timing | Force a playback speed |
| `boxW`, `boxH` | the GIF's own size | **Optional override.** Normally leave these out, because the box matches the GIF automatically |
| `boss_anim` | none | Enemy animation when the attack begins |
| `dialogue` | none | A line the boss says before the attack begins |

An attack **without** an `[ATTACK:]` section still works with the defaults.

```ini
[ATTACK:storm]
file = ATTACKS/storm.gif
damage = 20
duration = 600
boss_anim = angry
dialogue = HOLD STILL!
```

With that, `3 = storm` in an attack list plays `ATTACKS/storm.gif`.

---

## 6. Making attack GIFs

This is the core of making a fight. The engine **draws the current GIF frame over the battle box and uses its pixels as the hitboxes.**

### Size

**The battle box automatically matches your GIF.** If `storm.gif` is `240×150`, the box becomes `240×150` for that attack, and it smoothly resizes while the boss talks before the attack starts. Different attacks can therefore have different box shapes with no extra settings. Just draw each GIF at the size you want the arena to be.

1 GIF pixel = 1 screen pixel, so what you draw is exactly what hits. Good sizes:

| Box | Size |
|---|---|
| Classic square | `150×150` |
| Wide | `260×130` |
| Tall and narrow | `100×170` |

Limits: the box is clamped to **48–580 wide** and **48–245 tall** (keep height at 180 or less so it doesn't cover the party panel). A GIF outside those limits is scaled (nearest-neighbor) to fit, which makes its hitboxes slightly off, so stay inside them.

If you want to force a different box than the GIF, `[ATTACK:…]` still accepts optional `boxW` / `boxH`, but the GIF is then stretched to that size, so most mods should leave them out.

### Hit colors

The soul's hitbox is a circle of radius 6 around the heart's center. The engine checks every pixel of the **current frame** under it.

| Color | Rule of thumb | Detection |
|---|---|---|
| **White** | Always hurts | R, G, B all above 230 |
| **Cyan** | Hurts only if the player **is moving** ("stay still") | R < 80, G > 200, B > 220 |
| **Orange** | Hurts only if the player **is NOT moving** ("keep moving") | R > 220, 100 < G < 190, B < 80 |
| *Anything else* | Decoration only, never hurts | |

Recommended exact colors: `#FFFFFF`, `#00FFFF`, `#FF9900`.

Pixels with alpha below 50% are ignored, so transparent GIFs work.

### Rules for clean results

- **No anti-aliasing and no dithering.** Soft edges create in-between colors that don't count as hurtful, so the bullet looks solid but doesn't hit. Use hard-edged pixel art and turn off dithering on export.
- **Keep the center clear on frame 1.** The soul starts at the middle of the box with no invulnerability, so a bullet there hurts instantly.
- **Leave dodging room.** The heart is about 14 px wide, so leave gaps of at least 20 px. Holding `X`/`Shift` halves the soul speed, which also helps in tight patterns.
- **Frames play in order and loop** until `duration` runs out. Each frame is evaluated by itself, with no interpolation, so animate bullets by moving them between frames.
- **Graze:** a hurt-color pixel within 22 px of the soul (but not touching it) gives bonus TP, about 7.5 TP per second.
- **Invulnerability:** after a hit the soul is protected for 90 frames (1.5 s) and flashes.

### Other accepted formats

| Format | Notes |
|---|---|
| `.gif` | Full support: transparency, local color tables, interlacing, frame delays, disposal modes 2 and 3 |
| `name_stripN.png` | A horizontal strip of `N` equal-width frames, e.g. `spiral_strip8.png`. Default timing is 80 ms per frame. Use `fps` to change it |
| any other `.png`/`.jpg` | Treated as a single still frame |

GIF frame delays shorter than 20 ms are raised to 20 ms, and a delay of 0 is treated as 60 ms. Use `fps` in `[ATTACK:…]` if you need exact timing.

**Performance:** each GIF frame is stored uncompressed. Keep GIFs at box size (not larger) and under roughly 100–150 frames.

---

## 7. Making enemy sprites

Three options:

**A. GIF.** `sprite = ENEMY/boss.gif`. All frames are used, with the GIF's own timing for the default idle loop.

**B. Sprite sheet.** Set `frameW` and `frameH`. The image is cut into a grid and numbered left-to-right, top-to-bottom, starting at 0.

```
sheet 256×160, frameW = 64, frameH = 80
┌────┬────┬────┬────┐
│ 0  │ 1  │ 2  │ 3  │
├────┼────┼────┼────┤
│ 4  │ 5  │ 6  │ 7  │
└────┴────┴────┴────┘
```

**C. Single image.** Give no `frameW`/`frameH`, and the whole image is one frame.

Then use [`[ENEMY_ANIM:…]`](#enemy_animname) to build `idle`, `angry` and so on out of those frame numbers.

Placement:

- `x`, `y` is the sprite's **top-left**. The drawn size is `frame size × scale`.
- Keep `x + width × scale` within 640 and `y + height × scale` within about 280 so the sprite stays visible above the party panel.
- Use a transparent background. The engine does not remove background colors from enemy sprites.
- Susie's Rude Buster flies toward the **center** of the sprite.

---

## 8. Phases and dialogue

### When phases are checked

Triggers are evaluated once at the **start of each enemy turn** (after the player's commands finish), against the **first enemy still in the fight**. At most one phase fires per turn. If two would match, the first (lowest number) fires now and the next one can fire on a later turn.

When a phase fires:

1. The turn counter for attack lists resets to 1.
2. The phase's `boss_anim` plays.
3. The phase's `dialogue` is shown.
4. The phase's `flavor` pool replaces the enemy's.
5. The phase's `[PHASE_n_ATTACKS]` replaces the global attack list.

### Dialogue

Speech appears in a white bubble to the left of the enemy. Phase dialogue comes first, then any dialogue from the chosen attack, shown one line after another. While it's on screen, the battle box smoothly resizes to the coming attack's size.

- `Z` / `Enter`: finish typing the line; press again for the next one.
- `X` / `Shift`: skip the typing animation.
- The bubble is about 175×86 px. Keep each line to **roughly 70 characters or fewer** (about four lines of ~19 characters). Longer text can overflow the bubble.
- The bubble sits at `x = max(180, enemy.x − 193)` and `y = max(20, enemy.y)`. Its tail points right near the top of the bubble, so a mouth or head near the top of the sprite looks best.
- One line per `dialogue` key. For longer speeches, spread lines across several attacks or phases.

### Design tips

- Use **`hp_below`** for dramatic mid-fight changes, and **`mercy_above`** to reward peaceful play with a calmer phase.
- Set a final low-HP phase (for example `hp_below:25%`) with a faster, harder pattern and a strong line of dialogue.
- Remember that **reducing an enemy to 0 HP ends the fight just like sparing it**. The two endings share one victory text.

---

## 9. Combat rules cheat-sheet

### Commands

| Command | Who | Effect |
|---|---|---|
| FIGHT | All | Timing-bar minigame; damage depends on accuracy |
| ACT | **Kris only** | Runs one of the enemy's `acts` |
| MAGIC | Susie, Ralsei | Spell menu (below) |
| ITEM | All | Heal a party member |
| SPARE | All | +10 mercy; if mercy is already 100%, the enemy is spared |
| DEFEND | All | +16 TP, and damage taken is reduced to 60% this turn |

### Spells

| Spell | Who | TP | Effect |
|---|---|---|---|
| Rude Buster | Susie | 50 | Damage = `power × (2.5 + max(0, magic−10)×0.05) − enemy def` |
| S-Action | Susie | 0 | +25 mercy |
| Pacify | Ralsei | 16 | Spares an enemy **only if it is TIRED** |
| Heal Prayer | Ralsei | 32 | Heals one party member for `20 + magic` HP |
| R-Action | Ralsei | 0 | +25 mercy |

### FIGHT bar

| Hit distance from the red line | Result | Damage | TP gained |
|---|---|---|---|
| ≤ 4 px | PERFECT | `power × 1.5 − def` | +6 |
| ≤ 75 px | GOOD | `power × (1 − distance/100) − def` | +2 to +4 |
| further, or the bar passes | MISS | none (unless enemy `def` is negative) | 0 |

Damage is rounded down with a minimum of 1.

### Other rules

- **TP** starts at 16 and caps at 100.
- **TIRED:** an enemy below 50% HP becomes tired, or when an ACT with `tired = true` is used.
- **Mercy** caps at 100%. At 100% the name turns yellow, and SPARE ends that enemy's part in the fight.
- **Downed allies:** a member at 0 HP is DOWN. They recover a little HP each round and stand back up when positive. Healing also revives. If all three are down, it's game over.
- **Damage to the party:** `attack damage − member def` (minimum 1); DEFEND reduces it to 60%. Each enemy picks a random conscious target at the start of its attack, shown by a `TARGET` marker above that member.

---

## 10. Full example encounter

A two-phase boss with three ACTs, GIF attacks and dialogue. Save it as `MOD/encounter.ini`, with the sprite in `MOD/ENEMY/` and the attacks in `MOD/ATTACKS/`.

```ini
# ===== The Glitch Warden — example encounter =====

[ARENA]
w = 180
h = 150

[BATTLE]
victoryText = * The Warden powers down. Got 0 EXP and 200 D$. (Z to restart)
gameOverText = * YOUR SIGNAL WAS LOST. (Z to retry)

[PARTY_KRIS]
maxHp = 100

[PARTY_SUSIE]
power = 55
magic = 14

# ---------- Enemy ----------
[ENEMY]
name = Glitch Warden
hp = 400
def = 2
x = 440
y = 40
scale = 2
sprite = ENEMY/warden_sheet.png
frameW = 64
frameH = 80
acts = Check, Calm, Taunt
flavor = * The Warden's outline flickers into view.
flavor = * Static crawls across the floor.
flavor = * The Warden hums a broken tune.

[ENEMY_ANIM:idle]
frames = 0-3
ticks = 10

[ENEMY_ANIM:angry]
frames = 4-7
ticks = 6
loop = false

# ---------- ACTs ----------
[ACT:Check]
mercy = 0
text = * WARDEN - ATK 12 DEF 2. Hates loud noises.

[ACT:Calm]
mercy = 30
text = * You hum quietly. The flicker steadies.

[ACT:Taunt]
mercy = 0
tired = true
text = * You mock the Warden. It slumps, exhausted.

# ---------- Phase 1 ----------
[PHASE_1]
flavor = * The Warden's outline flickers.
flavor = * Static hisses from the walls.

[PHASE_1_ATTACKS]
1 = rain
2 = rain, sweep
3 = sweep
loop = 2

# ---------- Phase 2 (below half HP) ----------
[PHASE_2]
trigger = hp_below:50%
dialogue = Y-YOU... CAN'T... DELETE ME!
boss_anim = angry
flavor = * The Warden's outline tears apart.
flavor = * The air buzzes with static.

[PHASE_2_ATTACKS]
1 = storm
2 = storm, spiral
loop = 1

# ---------- Attack settings ----------
[ATTACK:rain]
file = ATTACKS/rain.gif
damage = 14
duration = 420

[ATTACK:sweep]
file = ATTACKS/sweep.gif
damage = 16
duration = 480

[ATTACK:storm]
file = ATTACKS/storm.gif
damage = 20
duration = 600
boss_anim = angry
dialogue = HOLD STILL!

[ATTACK:spiral]
file = ATTACKS/spiral_strip8.png
damage = 18
duration = 540
fps = 12
```

In this example `rain.gif` is 180×150, `sweep.gif` is 220×140 and `storm.gif` is 240×150, so the box changes shape for each one without any `boxW` / `boxH` lines.

What happens in this fight:

- **Turns 1–3:** `rain`, `rain` or `sweep`, `sweep`. After turn 3 it cycles turns 2 and 3.
- When the Warden drops to 50% HP, it says its line, plays `angry`, and the counter resets. It then alternates between phase 2's attack pools.
- Sparing path: `Calm` raises mercy by 30%, `Taunt` makes the Warden tired so Ralsei's Pacify works, and a SPARE at 100% mercy ends the fight.

---

## 11. Testing and debugging

- **Open the browser console** (F12). Missing or failed assets log `Could not load mod asset: <path>`.
- **Inspect the parsed config.** Type `loadedModConfig` in the console to see exactly how your INI was read: enemies, phases, attacks and so on. If a value is missing, the key name is probably misspelled or in the wrong section.
- **Reload a mod:** refresh the page (for auto-load), or use LOAD MOD / drag the folder in again. Each load restarts the battle and clears the asset cache.
- **Restart a fight:** win or lose and press `Z`.
- **Test one thing at a time:**
  - Put the attack you're building at `1 = myattack` so it plays on the very first enemy turn.
  - Use a low `hp` (like 40) on the enemy to reach later phases quickly.
  - Use a `turn:2` trigger on a phase to test it quickly.
- **Test the hitbox.** Add a small white square in the middle of the GIF on one frame and confirm it hurts. Then check that your cyan and orange colors behave as expected.

---

## 12. Troubleshooting

| Symptom | Likely cause and fix |
|---|---|
| Alert "No encounter.ini… found" | The folder you selected has no `encounter.ini` / `encounter.txt`. Select the folder that **contains** the INI (usually `MOD`) |
| Enemy is a green square | `sprite` path is wrong, or the file failed to load. Check the console |
| Works with LOAD MOD but not when hosted | Auto-load is case-sensitive. Use the exact folder names `ENEMY` / `ATTACKS` and exact file-name case, and serve the site over HTTP |
| Party members are colored rectangles | The sprite sheets aren't in `GAME/ASSETS/`, or the page isn't served over HTTP. Check the console |
| Auto-load does nothing | `MOD/encounter.ini` is missing, misnamed, or the page was opened from `file://` |
| Enemy is cut off or off-screen | `x` too large or `scale` too big. Keep `x + width×scale ≤ 640` |
| Attack GIF shows but never hurts | Colors aren't exactly white / cyan / orange, or edges are anti-aliased. Check the [hit color table](#hit-colors) |
| Attack hurts when it looks safe | The GIF is outside the 48–580 × 48–245 limits and was scaled, or you set a `boxW`/`boxH` override that stretches it. Resize the GIF into range and remove the override |
| Box is the wrong size | The box follows the GIF's pixel size. Check the GIF's real dimensions. If the attack image failed to load, the box falls back to `[ARENA]` |
| Built-in white bullets appear instead of my attack | The turn has no entry, the name doesn't match, or the file didn't load. Check the console |
| Same attack every turn | You only defined turn 1 and `loop = last` repeats it. Add more turns or set `loop = N` |
| Phase never triggers | Wrong trigger syntax (use `hp_below:50%`, no spaces around the colon), or it's already fired. Test with `turn:2` |
| Phase 2 attacks appear on turn 1 | Make sure phase 2 has a `trigger`. Phase 1 should have none |
| ACT text barely visible | It is only shown during the action animation. Keep it short |
| Dialogue is cut off | The line is too long for the bubble. Aim for 70 characters or fewer |
| Text turns into a number / crashes | A value made only of digits was parsed as a number. Add a letter or punctuation |
| Colors look wrong | Missing `#` in `color = ...` |
| Everything stops working from `file://` | Use LOAD MOD / drag-and-drop, or run `python3 -m http.server` |
| Mod files not found when dropped | Make sure file names are unique; the engine matches by name if the path doesn't match |

---

## 13. Limits and what's hard-coded

These live in `GAME/script.js`, not in the INI:

- **Party:** exactly Kris, Susie and Ralsei. Their sprite sheets live in `GAME/ASSETS/`, and their animations are built into `GAME/script.js`, so a mod can't replace them.
- **Spells and TP costs** (Rude Buster, Pacify, Heal Prayer, S-/R-Action) and **items** (Dark Candy ×3, +40 HP; Revive Mint ×1, +90 HP) are fixed. To change them, edit the `SPELLS` table and the `items` array in `initBattle()` in `GAME/script.js`.
- **ACTs are global**, not per enemy.
- **Multi-enemy fights:** every enemy shares the same attack sequence. Phase triggers read the first enemy still in the fight. Single-boss fights work best.
- **Win condition:** killing and sparing are treated the same.
- **Spoken text:** one line per `dialogue` key, and no inline formatting or colors.
- **Battle box size:** taken from each attack's GIF and clamped to 48–580 × 48–245. Its position is fixed (centered horizontally, around y = 190).
- **Resolution:** the game is fixed at 640×480 and scales to fit the window with letterboxing. All coordinates (`x`, `y`, arena sizes) are in that 640×480 space.
