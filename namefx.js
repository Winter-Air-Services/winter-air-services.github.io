/* ================================================================ name effects
   Guile, 2026-10-12: Order Run's name effects (D:\Order Run\app_template.html, 0.22–0.24.3),
   the whole of it — fifty ready-made looks, forty-eight movements, the colour wheel, the
   emoji, the outline, and where it shows — on the shop's names. Order Run is his own app: the
   engine and its tables came across as they are; the two screens were rewritten in this
   app's shape, a panel drawn from its state (docs/rules/ui.md).

   Set by the office (Users → a person → Name effect), seen by the shop on every phone. A
   customer never gets one (supabase/50). A decoration, never a permission.

   WHY IT DOES NOT LAG — each line paid for on Order Run's tablet:
   · each letter paints its own FIXED slice of the gradient and only transform/opacity move;
     a sliding background-clip:text re-rasterises its text every frame;
   · a name in a long list is `quiet`: the colours and the emoji, no letters, no motion —
     the badges on the job rows;
   · nothing moves off screen, under another screen, or while a finger is scrolling, and
     "reduce motion" on the phone stops all of it;
   · the glow is a text-shadow, never a filter (a filter is a render surface per name);
   · the editor's strip of fifty looks (≈260 animated spans) is drawn once; a tap redraws
     the preview and the cards under it, never the strip;
   · Settings → This phone → Name effects → Plain names draws none at all.

   Loaded before app.js; everything here is only CALLED later, so app.js's names (esc, db,
   write, stack…) are there by then. Every name here starts fx / FX_ / nameFx — a classic
   script's top-level const is shared with app.js, and a clash is a SyntaxError. */

// Where a name wears it. Winter's four, in place of Order Run's seven.
const FX_AREAS = [
  ['mine',    '👤 Their own name', 'At the top of the app, on their own phone.'],
  ['users',   '👥 Users',          'The Users list and the person’s own screen.'],
  ['jobs',    '🛠️ Jobs',           '“Assigned to …” on every job, the crew, and who asked for a job.'],
  ['history', '🕒 History',        'Who did what: a job’s history, its status and What to bring.'],
];
const FX_SPEED_SECS = {slow: 9, normal: 5, fast: 2.2};
/**
 * TWENTY-SIX WAYS TO MOVE.
 *
 *   slide   -- which way the colours travel under the letters. Every look has one, so a
 *              name is never a still picture.
 *   letters -- the name is cut into one span per letter, each with its own delay, and
 *              each painting its own gradient (see the .fx-cut note in the stylesheet).
 *   move    -- the whole name, emoji and all, moves as one piece.
 *   rand    -- the per-letter delay is rolled at random instead of stepped, so letters
 *              go off on their own with no rhythm to them. Re-rolled on every redraw,
 *              which is the point: "without a reason, without a timer".
 *   dx      -- each letter is told how far it sits from the middle of the word, so it
 *              can start there and fly out to its place.
 *
 * Every icon is Unicode 6 or older on purpose. 0.22.1 shipped four Unicode 12 emoji and
 * they drew as empty boxes on the phones here.
 */
const FX_ANIMS = [
  ['lr',      'Left \u2192 Right',     '\u2192',     {slide: 'lr'}],
  ['rl',      'Right \u2192 Left',     '\u2190',     {slide: 'rl'}],
  ['tb',      'Top \u2192 Bottom',     '\u2193',     {slide: 'tb'}],
  ['bt',      'Bottom \u2192 Top',     '\u2191',     {slide: 'bt'}],
  ['wave',    'Wave',                  '\u3030',     {letters: 'wave'}],
  ['bounce',  'Bounce',                '\u21E7',     {letters: 'bounce'}],
  ['twinkle', 'Twinkle',               '\u2726',     {letters: 'twinkle'}],
  ['type',    'Typewriter',            'Aa',         {letters: 'type'}],
  ['spell',   'Spell it out',          'A\u00b7B',   {letters: 'spell'}],
  ['pop',     'Pop, one by one',       '\u25CF',     {letters: 'pop'}],
  ['glitch',  'Glitch',                '\u26A1',     {letters: 'glitch'}],
  ['glitchy', 'Super glitch',          '\u2731',     {letters: 'glitch', rand: true}],
  ['shake',   'Shake',                 '\u2248',     {letters: 'shake'}],
  ['quake',   'Earthquake',            '\u2195',     {letters: 'quake'}],
  ['sway',    'Sway',                  '\u2194',     {letters: 'sway'}],
  ['jump',    'Random jump',           '\u2934',     {letters: 'jump', rand: true}],
  ['neon',    'Neon flicker',          '\u2600',     {letters: 'neon', rand: true}],
  ['gather',  'Gather',                '\u21E5',     {letters: 'gather', dx: true}],
  ['pulse',   'Pulse',                 '\u2665',     {move: 'pulse'}],
  ['zoom',    'Zoom',                  '\u26F6',     {move: 'zoom'}],
  ['rotate',  'Rotate',                '\u21BB',     {move: 'rotate'}],
  ['tornado', 'Tornado',               '\u{1F300}',  {move: 'tornado'}],
  ['spin',    'Entry rotate',          '\u21BA',     {move: 'spin'}],
  ['fade',    'Fade in, fade out',     '\u25D0',     {move: 'fade'}],
  ['wheel',   'Wheel entrance',        '\u25CC',     {move: 'wheel'}],
  ['sheep',   'Jumping sheep',         '\u293E',     {move: 'sheep'}],
  ['shine',   'Shine',                 '\u2727',     {letters: 'shine'}],
  ['stomp',   'Stomp',                 '\u21E9',     {letters: 'stomp'}],
  ['drift',   'Drift',                 '\u223F',     {letters: 'drift'}],
  ['fall',    'Falling',               '\u2745',     {letters: 'fall'}],
  ['flame',   'Flame',                 '\u{1F525}',  {letters: 'flame'}],
  ['drip',    'Drip',                  '\u25BC',     {letters: 'drip'}],
  ['heartbeat','Heartbeat',            '\u2661',     {letters: 'heartbeat'}],
  ['swirl',   'Swirl',                 '\u27F3',     {letters: 'swirl'}],
  ['breathe', 'Breathe',               '\u25CB',     {move: 'breathe'}],
  ['elastic', 'Elastic',               '\u21D5',     {letters: 'elastic'}],
  ['rise',    'Rise',                  '\u21D1',     {letters: 'rise'}],
  ['blink',   'Blink',                 '\u25D1',     {letters: 'blink'}],
  ['wobble',  'Wobble',                '\u21C4',     {letters: 'wobble'}],
  ['float',   'Float away',            '\u21A1',     {letters: 'float'}],
  ['bulge',   'Bulge',                 '\u25C9',     {letters: 'bulge'}],
  ['flip',    'Flip',                  '\u21CB',     {letters: 'flip'}],
  ['twirl',   'Twirl in',              '\u27F2',     {letters: 'twirl'}],
  ['erase',   'Eraser',                '\u232B',     {letters: 'erase', reverse: true}],
  ['blur',    'Out of focus',          '\u2592',     {letters: 'blur'}],
  ['chroma',  'Chroma split',          '\u25EB',     {letters: 'chroma'}],
  ['expand',  'Expand',                '\u21FF',     {move: 'expand'}],
  ['converge','Converge',              '\u21C9',     {move: 'converge'}],
];
const FX_ANIM_MAP = Object.fromEntries(FX_ANIMS.map(a=> [a[0], a[3]]));
// How long one go of the EFFECT takes, against how long the colours take to travel. They
// are different clocks: a glitch wants to be quick over a gradient that drifts.
const FX_EFFECT_SECS = {slow: 5.4, normal: 3, fast: 1.5};
// 1..4 on the slider, in em so it follows the text size. A 2px stroke looks right on the
// 26px preview and eats a 13px name alive.
const FX_STROKE = ['0', '0.035em', '0.06em', '0.085em', '0.115em'];
const FX_EMOJI_TOP = ['\u{1F451}','\u2B50','\u{1F525}','\u{1F48E}','\u2728','\u{1F3C6}',
                      '\u26A1','\u{1F680}','\u{1F984}','\u{1F981}','\u{1F340}','\u{1F4AF}'];
const FX_EMOJI_GROUPS = [
  ['Smileys', [
    '\u{1F600}','\u{1F601}','\u{1F602}','\u{1F603}','\u{1F604}','\u{1F605}','\u{1F606}','\u{1F607}',
    '\u{1F608}','\u{1F609}','\u{1F60A}','\u{1F60B}','\u{1F60C}','\u{1F60D}','\u{1F60E}','\u{1F60F}',
    '\u{1F610}','\u{1F611}','\u{1F612}','\u{1F613}','\u{1F614}','\u{1F615}','\u{1F616}','\u{1F617}',
    '\u{1F618}','\u{1F619}','\u{1F61A}','\u{1F61B}','\u{1F61C}','\u{1F61D}','\u{1F61E}','\u{1F61F}',
    '\u{1F620}','\u{1F621}','\u{1F622}','\u{1F623}','\u{1F624}','\u{1F625}','\u{1F626}','\u{1F627}',
    '\u{1F628}','\u{1F629}','\u{1F62A}','\u{1F62B}','\u{1F62C}','\u{1F62D}','\u{1F62E}','\u{1F62F}',
    '\u{1F630}','\u{1F631}','\u{1F632}','\u{1F633}','\u{1F634}','\u{1F635}','\u{1F636}','\u{1F637}',
    '\u{1F638}','\u{1F639}','\u{1F63A}','\u{1F63B}','\u{1F63C}','\u{1F63D}','\u{1F63E}','\u{1F63F}',
    '\u{1F640}','\u{1F641}','\u{1F642}','\u{1F643}','\u{1F644}','\u{1F645}','\u{1F646}','\u{1F647}',
    '\u{1F648}','\u{1F649}','\u{1F64A}','\u{1F64B}','\u{1F64C}','\u{1F64D}','\u{1F64E}','\u{1F64F}',
    '\u{1F479}','\u{1F47A}','\u{1F47B}','\u{1F47C}','\u{1F47D}','\u{1F47E}','\u{1F47F}','\u{1F480}',
    '\u{1F4A9}','\u{263A}\uFE0F','\u{2639}\uFE0F','\u{1F910}','\u{1F911}','\u{1F912}','\u{1F913}',
    '\u{1F914}','\u{1F915}','\u{1F916}','\u{1F917}','\u{1F918}','\u{1F920}','\u{1F921}','\u{1F922}',
    '\u{1F923}','\u{1F924}','\u{1F925}','\u{1F927}','\u{1F930}']],
  ['Hands and people', [
    '\u{1F44A}','\u{1F44B}','\u{1F44C}','\u{1F44D}','\u{1F44E}','\u{1F44F}','\u{1F450}',
    '\u{270A}\uFE0F','\u{270B}\uFE0F','\u{270C}\uFE0F','\u{270D}\uFE0F','\u{1F446}','\u{1F447}',
    '\u{1F448}','\u{1F449}','\u{1F4AA}','\u{1F440}','\u{1F444}','\u{1F445}','\u{1F442}','\u{1F443}',
    '\u{1F485}','\u{1F919}','\u{1F91A}','\u{1F91B}','\u{1F91C}','\u{1F91D}','\u{1F91E}','\u{1F466}',
    '\u{1F467}','\u{1F468}','\u{1F469}','\u{1F470}','\u{1F471}','\u{1F472}','\u{1F473}','\u{1F474}',
    '\u{1F475}','\u{1F476}','\u{1F477}','\u{1F478}','\u{1F482}','\u{1F483}','\u{1F486}','\u{1F487}',
    '\u{1F934}','\u{1F935}','\u{1F936}','\u{1F937}','\u{1F938}','\u{1F93A}','\u{1F93C}','\u{1F93D}',
    '\u{1F93E}']],
  ['Animals', [
    '\u{1F400}','\u{1F401}','\u{1F402}','\u{1F403}','\u{1F404}','\u{1F405}','\u{1F406}','\u{1F407}',
    '\u{1F408}','\u{1F409}','\u{1F40A}','\u{1F40B}','\u{1F40C}','\u{1F40D}','\u{1F40E}','\u{1F40F}',
    '\u{1F410}','\u{1F411}','\u{1F412}','\u{1F413}','\u{1F414}','\u{1F415}','\u{1F416}','\u{1F417}',
    '\u{1F418}','\u{1F419}','\u{1F41A}','\u{1F41B}','\u{1F41C}','\u{1F41D}','\u{1F41E}','\u{1F41F}',
    '\u{1F420}','\u{1F421}','\u{1F422}','\u{1F423}','\u{1F424}','\u{1F425}','\u{1F426}','\u{1F427}',
    '\u{1F428}','\u{1F429}','\u{1F42A}','\u{1F42B}','\u{1F42C}','\u{1F42D}','\u{1F42E}','\u{1F42F}',
    '\u{1F430}','\u{1F431}','\u{1F432}','\u{1F433}','\u{1F434}','\u{1F435}','\u{1F436}','\u{1F437}',
    '\u{1F438}','\u{1F439}','\u{1F43A}','\u{1F43B}','\u{1F43C}','\u{1F43D}','\u{1F43E}','\u{1F980}',
    '\u{1F981}','\u{1F982}','\u{1F983}','\u{1F984}','\u{1F985}','\u{1F986}','\u{1F987}','\u{1F988}',
    '\u{1F989}','\u{1F98A}','\u{1F98B}','\u{1F98C}','\u{1F98D}','\u{1F98E}','\u{1F98F}','\u{1F990}',
    '\u{1F991}','\u{1F577}\uFE0F','\u{1F578}\uFE0F','\u{1F54A}\uFE0F']],
  ['Plants and nature', [
    '\u{1F330}','\u{1F331}','\u{1F332}','\u{1F333}','\u{1F334}','\u{1F335}','\u{1F336}\uFE0F',
    '\u{1F337}','\u{1F338}','\u{1F339}','\u{1F33A}','\u{1F33B}','\u{1F33C}','\u{1F33D}','\u{1F33E}',
    '\u{1F33F}','\u{1F340}','\u{1F341}','\u{1F342}','\u{1F343}','\u{1F344}','\u{1F490}','\u{1F4AE}',
    '\u{2618}\uFE0F']],
  ['Sky and weather', [
    '\u{2600}\uFE0F','\u{2601}\uFE0F','\u{2602}\uFE0F','\u{2603}\uFE0F','\u{2604}\uFE0F',
    '\u{26C4}\uFE0F','\u{26C5}\uFE0F','\u{26A1}\uFE0F','\u{2744}\uFE0F','\u{2728}\uFE0F',
    '\u{2B50}\uFE0F','\u{1F300}','\u{1F301}','\u{1F302}','\u{1F303}','\u{1F304}','\u{1F305}',
    '\u{1F306}','\u{1F307}','\u{1F308}','\u{1F309}','\u{1F30A}','\u{1F30B}','\u{1F30C}','\u{1F311}',
    '\u{1F312}','\u{1F313}','\u{1F314}','\u{1F315}','\u{1F316}','\u{1F317}','\u{1F318}','\u{1F319}',
    '\u{1F31A}','\u{1F31B}','\u{1F31C}','\u{1F31D}','\u{1F31E}','\u{1F31F}','\u{1F320}',
    '\u{1F324}\uFE0F','\u{1F325}\uFE0F','\u{1F326}\uFE0F','\u{1F327}\uFE0F','\u{1F328}\uFE0F',
    '\u{1F329}\uFE0F','\u{1F32A}\uFE0F','\u{1F32B}\uFE0F','\u{1F32C}\uFE0F','\u{1F4A7}','\u{1F4A8}',
    '\u{1F4A5}','\u{1F4AB}','\u{1F525}','\u{1F30D}','\u{1F30E}','\u{1F30F}','\u{1F310}']],
  ['Food and drink', [
    '\u{1F345}','\u{1F346}','\u{1F347}','\u{1F348}','\u{1F349}','\u{1F34A}','\u{1F34B}','\u{1F34C}',
    '\u{1F34D}','\u{1F34E}','\u{1F34F}','\u{1F350}','\u{1F351}','\u{1F352}','\u{1F353}','\u{1F354}',
    '\u{1F355}','\u{1F356}','\u{1F357}','\u{1F358}','\u{1F359}','\u{1F35A}','\u{1F35B}','\u{1F35C}',
    '\u{1F35D}','\u{1F35E}','\u{1F35F}','\u{1F360}','\u{1F361}','\u{1F362}','\u{1F363}','\u{1F364}',
    '\u{1F365}','\u{1F366}','\u{1F367}','\u{1F368}','\u{1F369}','\u{1F36A}','\u{1F36B}','\u{1F36C}',
    '\u{1F36D}','\u{1F36E}','\u{1F36F}','\u{1F370}','\u{1F371}','\u{1F372}','\u{1F373}','\u{1F374}',
    '\u{1F375}','\u{1F376}','\u{1F377}','\u{1F378}','\u{1F379}','\u{1F37A}','\u{1F37B}','\u{1F37C}',
    '\u{1F37D}\uFE0F','\u{1F37E}','\u{1F37F}','\u{1F32D}','\u{1F32E}','\u{1F32F}','\u{1F950}',
    '\u{1F951}','\u{1F952}','\u{1F953}','\u{1F954}','\u{1F955}','\u{1F956}','\u{1F957}','\u{1F958}',
    '\u{1F959}','\u{1F95A}','\u{1F95B}','\u{1F95C}','\u{1F95D}','\u{1F95E}','\u{2615}\uFE0F',
    '\u{1F942}','\u{1F943}','\u{1F944}']],
  ['Travel and places', [
    '\u{1F680}','\u{1F681}','\u{1F682}','\u{1F683}','\u{1F684}','\u{1F685}','\u{1F686}','\u{1F687}',
    '\u{1F688}','\u{1F689}','\u{1F68A}','\u{1F68B}','\u{1F68C}','\u{1F68D}','\u{1F68E}','\u{1F68F}',
    '\u{1F690}','\u{1F691}','\u{1F692}','\u{1F693}','\u{1F694}','\u{1F695}','\u{1F696}','\u{1F697}',
    '\u{1F698}','\u{1F699}','\u{1F69A}','\u{1F69B}','\u{1F69C}','\u{1F69D}','\u{1F69E}','\u{1F69F}',
    '\u{1F6A0}','\u{1F6A1}','\u{1F6A2}','\u{1F6A3}','\u{1F6A4}','\u{1F6B2}','\u{1F6B4}','\u{1F6B5}',
    '\u{2708}\uFE0F','\u{26F5}\uFE0F','\u{2693}\uFE0F','\u{1F3E0}','\u{1F3E1}','\u{1F3E2}',
    '\u{1F3E3}','\u{1F3E4}','\u{1F3E5}','\u{1F3E6}','\u{1F3E7}','\u{1F3E8}','\u{1F3E9}','\u{1F3EA}',
    '\u{1F3EB}','\u{1F3EC}','\u{1F3ED}','\u{1F3EF}','\u{1F3F0}','\u{26EA}\uFE0F','\u{26F2}\uFE0F',
    '\u{26F0}\uFE0F','\u{1F5FB}','\u{1F5FC}','\u{1F5FD}','\u{1F5FE}','\u{1F5FF}','\u{1F3D4}\uFE0F',
    '\u{1F3D5}\uFE0F','\u{1F3D6}\uFE0F','\u{1F3DD}\uFE0F','\u{1F3DE}\uFE0F','\u{1F3DF}\uFE0F']],
  ['Fun and sport', [
    '\u{1F380}','\u{1F381}','\u{1F382}','\u{1F383}','\u{1F384}','\u{1F385}','\u{1F386}','\u{1F387}',
    '\u{1F388}','\u{1F389}','\u{1F38A}','\u{1F38B}','\u{1F38C}','\u{1F38D}','\u{1F38E}','\u{1F38F}',
    '\u{1F390}','\u{1F391}','\u{1F392}','\u{1F393}','\u{1F3A0}','\u{1F3A1}','\u{1F3A2}','\u{1F3A3}',
    '\u{1F3A4}','\u{1F3A5}','\u{1F3A6}','\u{1F3A7}','\u{1F3A8}','\u{1F3A9}','\u{1F3AA}','\u{1F3AB}',
    '\u{1F3AC}','\u{1F3AD}','\u{1F3AE}','\u{1F3AF}','\u{1F3B0}','\u{1F3B1}','\u{1F3B2}','\u{1F3B3}',
    '\u{1F3B4}','\u{1F3B5}','\u{1F3B6}','\u{1F3B7}','\u{1F3B8}','\u{1F3B9}','\u{1F3BA}','\u{1F3BB}',
    '\u{1F3BC}','\u{1F3BD}','\u{1F3BE}','\u{1F3BF}','\u{1F3C0}','\u{1F3C1}','\u{1F3C2}','\u{1F3C3}',
    '\u{1F3C4}','\u{1F3C5}','\u{1F3C6}','\u{1F3C7}','\u{1F3C8}','\u{1F3C9}','\u{1F3CA}',
    '\u{26BD}\uFE0F','\u{26BE}\uFE0F','\u{26F3}\uFE0F','\u{1F0CF}','\u{1F004}','\u{1F947}',
    '\u{1F948}','\u{1F949}','\u{1F94A}','\u{1F94B}','\u{1F93B}','\u{1F3F9}','\u{1F945}']],
  ['Things', [
    '\u{1F4A1}','\u{1F4A2}','\u{1F4A3}','\u{1F4A4}','\u{1F4A6}','\u{1F4AC}','\u{1F4AD}','\u{1F4AF}',
    '\u{1F4B0}','\u{1F4B1}','\u{1F4B2}','\u{1F4B3}','\u{1F4B4}','\u{1F4B5}','\u{1F4B6}','\u{1F4B7}',
    '\u{1F4B8}','\u{1F4B9}','\u{1F4BA}','\u{1F4BB}','\u{1F4BC}','\u{1F4BD}','\u{1F4BE}','\u{1F4BF}',
    '\u{1F4C0}','\u{1F4C1}','\u{1F4C2}','\u{1F4C3}','\u{1F4C4}','\u{1F4C5}','\u{1F4C6}','\u{1F4C7}',
    '\u{1F4C8}','\u{1F4C9}','\u{1F4CA}','\u{1F4CB}','\u{1F4CC}','\u{1F4CD}','\u{1F4CE}','\u{1F4CF}',
    '\u{1F4D0}','\u{1F4D1}','\u{1F4D2}','\u{1F4D3}','\u{1F4D4}','\u{1F4D5}','\u{1F4D6}','\u{1F4D7}',
    '\u{1F4D8}','\u{1F4D9}','\u{1F4DA}','\u{1F4DB}','\u{1F4DC}','\u{1F4DD}','\u{1F4DE}','\u{1F4DF}',
    '\u{1F4E0}','\u{1F4E1}','\u{1F4E2}','\u{1F4E3}','\u{1F4E4}','\u{1F4E5}','\u{1F4E6}','\u{1F4E7}',
    '\u{1F4E8}','\u{1F4E9}','\u{1F4EA}','\u{1F4EB}','\u{1F4EC}','\u{1F4ED}','\u{1F4EE}','\u{1F4EF}',
    '\u{1F4F0}','\u{1F4F1}','\u{1F4F2}','\u{1F4F3}','\u{1F4F4}','\u{1F4F5}','\u{1F4F6}','\u{1F4F7}',
    '\u{1F4F8}','\u{1F4F9}','\u{1F4FA}','\u{1F4FB}','\u{1F4FC}','\u{1F4FD}\uFE0F','\u{1F4FE}',
    '\u{1F4FF}','\u{1F526}','\u{1F527}','\u{1F528}','\u{1F529}','\u{1F52A}','\u{1F52B}','\u{1F52C}',
    '\u{1F52D}','\u{1F52E}','\u{1F50D}','\u{1F511}','\u{1F512}','\u{1F513}','\u{1F514}','\u{1F515}',
    '\u{1F516}','\u{1F517}','\u{1F518}','\u{1F5E1}\uFE0F','\u{2699}\uFE0F','\u{2696}\uFE0F',
    '\u{2694}\uFE0F','\u{2692}\uFE0F','\u{1F6E1}\uFE0F','\u{1F6AC}','\u{1F6CE}\uFE0F',
    '\u{231A}\uFE0F','\u{231B}\uFE0F','\u{23F0}\uFE0F','\u{23F1}\uFE0F','\u{23F3}\uFE0F','\u{1F48D}',
    '\u{1F48E}']],
  ['Hearts and marks', [
    '\u{2764}\uFE0F','\u{1F493}','\u{1F494}','\u{1F495}','\u{1F496}','\u{1F497}','\u{1F498}',
    '\u{1F499}','\u{1F49A}','\u{1F49B}','\u{1F49C}','\u{1F49D}','\u{1F49E}','\u{1F49F}','\u{1F5A4}',
    '\u{2763}\uFE0F','\u{2705}\uFE0F','\u{274C}\uFE0F','\u{2714}\uFE0F','\u{2716}\uFE0F',
    '\u{2757}\uFE0F','\u{2753}\uFE0F','\u{2755}\uFE0F','\u{2754}\uFE0F','\u{1F51D}','\u{1F51E}',
    '\u{269C}\uFE0F','\u{1F531}','\u{1F532}','\u{1F533}','\u{267B}\uFE0F','\u{2648}\uFE0F',
    '\u{2649}\uFE0F','\u{264A}\uFE0F','\u{264B}\uFE0F','\u{264C}\uFE0F','\u{264D}\uFE0F',
    '\u{264E}\uFE0F','\u{264F}\uFE0F','\u{2650}\uFE0F','\u{2651}\uFE0F','\u{2652}\uFE0F',
    '\u{2653}\uFE0F','\u{26CE}\uFE0F','\u{262E}\uFE0F','\u{262F}\uFE0F','\u{271D}\uFE0F',
    '\u{2622}\uFE0F','\u{2623}\uFE0F','\u{267E}\uFE0F','\u{2721}\uFE0F','\u{1F52F}']],
];
// Flattened, and this is also what cleanFx() checks against: an effect arrives as free
// jsonb, so the emoji is only ever one this app itself offers.
const FX_EMOJIS = [...new Set([...FX_EMOJI_TOP, ...FX_EMOJI_GROUPS.flatMap(g=> g[1])])];
/**
 * READY-MADE LOOKS.
 *
 * Most of the people who will use this do not want to choose three colours, a glow, an
 * outline and a movement -- they want to look good and get on with the round. Each one of
 * these sets all five in a single tap, and the button shows what it does rather than
 * describing it. Everything stays editable afterwards.
 *
 * [name, emoji, [colours], glow, movement, outline]
 *
 * One flat list, on purpose. It used to be four groups in four separate strips, which on a
 * PC meant four things to scroll and three looks nobody ever saw.
 */
const FX_PRESETS = [
  ['GOAT',        '\u{1F451}',     ['#f59e0b','#eab308','#f97316'], '#f59e0b', 'stomp',      '#78350f'],
  ['Joker',       '\u{1F0CF}',     ['#a855f7','#ec4899','#ef4444'], '#a855f7', 'glitchy',  '#1e1b4b'],
  ['VIP',         '\u{1F48E}',     ['#06b6d4','#3b82f6','#a855f7'], '#06b6d4', 'shine', '#ffffff'],
  ['Premium',     '\u2728',        ['#eab308','#f59e0b','#ec4899'], '#eab308', 'twinkle', '#451a03'],
  ['Legend',      '\u{1F3C6}',     ['#f59e0b','#ef4444','#f97316'], '#f97316', 'spin',   '#7f1d1d'],
  ['Boss',        '\u{1F4BC}',     ['#94a3b8','#3b82f6','#6366f1'], '#3b82f6', 'stomp',    '#0f172a'],
  ['Alpha',       '\u{1F43A}',     ['#94a3b8','#06b6d4','#3b82f6'], '#06b6d4', 'jump',    '#0f172a'],
  ['Galaxy',      '\u{1F30C}',     ['#6366f1','#a855f7','#d946ef'], '#a855f7', 'drift',      '#1e1b4b'],
  ['Winter',      '\u2744\uFE0F',  ['#06b6d4','#0ea5e9','#94a3b8'], '#06b6d4', 'fall',      '#ffffff'],
  ['Summer',      '\u2600\uFE0F',  ['#eab308','#f59e0b','#f97316'], '#eab308', 'flame',   '#7c2d12'],
  ['Autumn',      '\u{1F341}',     ['#f97316','#a97142','#ef4444'], '#f97316', 'fall',    '#451a03'],
  ['Eclipse',     '\u{1F311}',     ['#6366f1','#94a3b8','#a855f7'], '#6366f1', 'rotate',  '#020617'],
  ['Nebula',      '\u{1F320}',     ['#d946ef','#6366f1','#06b6d4'], '#d946ef', 'drift',   '#1e1b4b'],
  ['Aurora',      '\u{1F30C}',     ['#22c55e','#06b6d4','#a855f7'], '#22c55e', 'wave',    '#052e16'],
  ['Gold',        '\u{1F947}',     ['#f59e0b','#eab308','#f59e0b'], '#eab308', 'shine',      '#78350f'],
  ['Cash',        '\u{1F4B5}',     ['#22c55e','#84cc16','#14b8a6'], '#22c55e', 'type',    '#14532d'],
  ['Diamond',     '\u{1F48E}',     ['#06b6d4','#94a3b8','#0ea5e9'], '#06b6d4', 'shine', '#ffffff'],
  ['Crypto',      '\u{1F4B0}',     ['#f59e0b','#eab308','#84cc16'], '#eab308', 'spell',  '#422006'],
  ['Luxury',      '\u{1F942}',     ['#eab308','#ec4899','#a855f7'], '#ec4899', 'wheel',   '#4a044e'],
  ['Royal',       '\u{1F451}',     ['#a855f7','#6366f1','#d946ef'], '#a855f7', 'zoom',    '#2e1065'],
  ['Inferno',     '\u{1F525}',     ['#ef4444','#f97316','#eab308'], '#ef4444', 'flame',      '#450a0a'],
  ['Blizzard',    '\u{1F328}\uFE0F', ['#94a3b8','#06b6d4','#0ea5e9'], '#0ea5e9', 'shake',    '#ffffff'],
  ['Vortex',      '\u{1F32A}\uFE0F', ['#14b8a6','#94a3b8','#06b6d4'], '#14b8a6', 'swirl','#042f2e'],
  ['Magma',       '\u{1F30B}',     ['#ef4444','#a97142','#f97316'], '#ef4444', 'quake',   '#450a0a'],
  ['Thunder',     '\u26A1',        ['#eab308','#0ea5e9','#6366f1'], '#eab308', 'glitch',  '#1e1b4b'],
  ['Toxic',       '\u2623\uFE0F',  ['#84cc16','#22c55e','#eab308'], '#84cc16', 'neon',    '#1a2e05'],
  ['Phantom',     '\u{1F47B}',     ['#94a3b8','#a855f7','#6366f1'], '#a855f7', 'fade',    '#e2e8f0'],
  ['Girly',       '\u{1F496}',     ['#f472b6','#ec4899','#f9a8d4'], '#f472b6', 'heartbeat',     '#ffffff'],
  ['Cute',        '\u{1F430}',     ['#fda4af','#fbcfe8','#a5b4fc'], '#fbcfe8', 'bounce',  '#ffffff'],
  ['Sakura',      '\u{1F338}',     ['#f9a8d4','#fbcfe8','#f472b6'], '#f9a8d4', 'fall',    '#ffffff'],
  ['White sky',   '\u2601\uFE0F',  ['#ffffff','#e0f2fe','#bae6fd'], '#ffffff', 'breathe',    '#64748b'],
  ['Dark matter', '\u{1F311}',     ['#312e81','#4c1d95','#1e1b4b'], '#a855f7', 'tornado', '#c4b5fd'],
  ['Shadow',      '\u{1F480}',     ['#0f172a','#334155','#1e293b'], '#000000', 'drip', '#94a3b8'],
  ['Ghost',       '\u{1F47B}',     ['#e2e8f0','#cbd5e1','#ffffff'], '#ffffff', 'breathe',    '#64748b'],
  ['Ink',         '\u{1F5A4}',     ['#000000','#475569','#000000'], '#334155', 'drip',    '#ffffff'],
  ['Snow',        '\u2744\uFE0F',  ['#ffffff','#bae6fd','#ffffff'], '#bae6fd', 'twinkle', '#0ea5e9'],
  ['Sheep',       '\u{1F411}',     ['#f8fafc','#e2e8f0','#cbd5e1'], '#94a3b8', 'sheep',   '#475569'],
  ['Bubblegum',   '\u{1F36C}',     ['#f9a8d4','#f472b6','#fef08a'], '#f472b6', 'elastic', '#ffffff'],
  ['Retro',       '\u{1F4FC}',     ['#fbbf24','#f97316','#a97142'], '#f97316', 'chroma',  '#451a03'],
  ['Arcade',      '\u{1F3AE}',     ['#22d3ee','#d946ef','#818cf8'], '#d946ef', 'flip',    '#0f172a'],
  ['Vapor',       '\u{1F334}',     ['#f472b6','#22d3ee','#a78bfa'], '#22d3ee', 'wobble',  '#4c1d95'],
  ['Sunrise',     '\u{1F305}',     ['#fb923c','#fbbf24','#f472b6'], '#fb923c', 'rise',    '#7c2d12'],
  ['Ocean',       '\u{1F30A}',     ['#0ea5e9','#14b8a6','#0369a1'], '#0ea5e9', 'float',   '#082f49'],
  ['Candy',       '\u{1F36D}',     ['#fda4af','#a5f3fc','#fde68a'], '#fda4af', 'bulge',   '#ffffff'],
  ['Mist',        '\u{1F32B}\uFE0F', ['#cbd5e1','#94a3b8','#e2e8f0'], '#cbd5e1', 'blur',  '#475569'],
  ['Comet',       '\u2604\uFE0F',  ['#e0f2fe','#38bdf8','#6366f1'], '#38bdf8', 'twirl',   '#0c4a6e'],
  ['Disco',       '\u{1F3B6}',     ['#f472b6','#facc15','#22d3ee'], '#facc15', 'blink',   '#1e1b4b'],
  ['Spotlight',   '\u{1F526}',     ['#fef9c3','#fde047','#ffffff'], '#fde047', 'expand',  '#713f12'],
  ['Cinema',      '\u{1F3AC}',     ['#e5e7eb','#9ca3af','#f3f4f6'], '#9ca3af', 'converge','#111827'],
  ['Vanish',      '\u{1F5E1}\uFE0F', ['#64748b','#1e293b','#475569'], '#334155', 'erase', '#94a3b8'],
];
// The look the sample wears before anybody has chosen one, so "Name effect" is not a
// heading over a plain word.
const FX_DEMO = {colors: ['#f59e0b', '#ec4899', '#a855f7'], glow: '#ec4899', speed: 'normal',
                 emoji: '\u2728', mid: 50, angle: 90, outline: '', outlineWidth: 0,
                 outlineGlow: false, anim: 'lr', where: {}};

/* NOTHING OUT OF THIS IS TRUSTED. It arrives as free jsonb and is about to be pasted into a
   style attribute: anything that is not a plain #rrggbb, or a word from the lists above, is
   dropped rather than escaped. */
function cleanFx(raw){
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const hex = v => /^#[0-9a-fA-F]{6}$/.test(String(v || '')) ? String(v) : '';
  const num = (v, lo, hi, dflt) => { const n = Number(v);
    return Number.isFinite(n) ? Math.max(lo, Math.min(hi, Math.round(n))) : dflt; };
  const colors = (Array.isArray(raw.colors) ? raw.colors : []).map(hex).filter(Boolean).slice(0, 3);
  if (!colors.length) return null;
  const where = {};
  FX_AREAS.forEach(([k]) => { where[k] = !!(raw.where && raw.where[k]); });
  const outline = hex(raw.outline);
  return {colors, mid: num(raw.mid, 10, 90, 50), angle: num(raw.angle, 0, 359, 90), glow: hex(raw.glow),
          outline, outlineWidth: outline ? num(raw.outlineWidth, 1, 4, 2) : 0,
          outlineGlow: !!outline && !!raw.outlineGlow,
          anim: FX_ANIM_MAP[raw.anim] ? raw.anim : 'lr',
          speed: FX_SPEED_SECS[raw.speed] ? raw.speed : 'normal',
          emoji: FX_EMOJIS.includes(raw.emoji) ? raw.emoji : '', where};
}
// cleaned once per object, not once per name drawn: a Jobs list draws the same few dozen times
const fxCleanCache = new WeakMap();
const fxClean = raw => { if (!raw || typeof raw !== 'object') return null;
  if (!fxCleanCache.has(raw)) fxCleanCache.set(raw, cleanFx(raw)); return fxCleanCache.get(raw); };

/* Each person's own choice for their phone, never sent anywhere: off is a plain escaped
   name — no gradient, no spans, nothing to paint. */
const fxShown = () => { try { return localStorage.getItem('ws_fx_off') !== '1'; } catch (e) { return true; } };

// By id first; by name for the lines that carry only a name (a job's history, from the server)
function fxFor(uid, name){
  if (typeof db === 'undefined' || !db) return null;
  const staff = db.staff || [];
  if (uid){
    const s = staff.find(x => x.id === uid);
    if (s && s.fx) return fxClean(s.fx);
    const t = db.team && db.team[uid];
    return t && t.name_fx ? fxClean(t.name_fx) : null;
  }
  const n = String(name || '').trim().toLowerCase();
  if (!n) return null;
  const hit = staff.find(x => x.fx && String(x.name || '').trim().toLowerCase() === n);
  return hit ? fxClean(hit.fx) : null;
}

/* A name, painted — or the plain escaped name: nobody set one, this area is switched off,
   this phone said Plain names, or a customer (who has no staff list at all).
   It RETURNS HTML: a caller must never esc() the result. */
function nameFx(name, uid, area, quiet){
  const s = String(name || '');
  if (!s || !fxShown()) return esc(s);
  const fx = fxFor(uid, s);
  if (!fx || (area && !fx.where[area])) return esc(s);
  return fxMarkup(s, fx, quiet);
}
// a preview: the switch does not apply — somebody looking at the editor asked to see it
const fxPreview = (name, fx) => { const c = cleanFx(fx); return c ? fxMarkup(String(name || ''), c) : esc(name); };

/* The name cut into letters, each with its own delay and its own slice of the colours. */
function fxLetters(name, esecs, spec, emoji){
  const chars = Array.from(name);
  if (emoji) chars.push(emoji);   // the emoji rides along as the last letter
  const n = Math.max(1, chars.length);
  const step = spec.letters === 'spell' || spec.letters === 'type' ? Math.min(0.17, (esecs * 0.34) / n)
    : spec.letters === 'twinkle' || spec.letters === 'neon' ? 0.19 : 0.07;
  const mid = (n - 1) / 2;
  return chars.map((ch, i) => {
    const eff = spec.rand ? Math.random() * esecs : (spec.reverse ? (n - 1 - i) : i) * step;
    const dx = spec.dx ? `--dx:${((mid - i) * 0.62).toFixed(2)}em;` : '';
    const last = emoji && i === chars.length - 1;
    const slice = n > 1 ? `background-position:${(i / (n - 1) * 100).toFixed(1)}% 0;` : '';
    return `<span class="fx-l${last ? ' fx-emoji' : ''}" style="${dx}${slice}animation-delay:${eff.toFixed(3)}s">${esc(ch)}</span>`;
  }).join('');
}
function fxMarkup(name, fx, quiet){
  const c = fx.colors, a = c[0], b = c[1] || c[0], d = c[2] || c[1] || c[0];
  const secs = FX_SPEED_SECS[fx.speed] || FX_SPEED_SECS.normal;
  const esecs = FX_EFFECT_SECS[fx.speed] || FX_EFFECT_SECS.normal;
  const anim = FX_ANIM_MAP[fx.anim] || FX_ANIM_MAP.lr;
  const shadow = [];
  if (fx.glow) shadow.push(`0 0 6px ${fx.glow}`);
  if (fx.outline && fx.outlineGlow) shadow.push(`0 0 3px ${fx.outline}`);
  const bpos = (Math.max(10, Math.min(90, fx.mid || 50)) * 0.6666).toFixed(2);
  const ink = `--fx-a:${a};--fx-b:${b};--fx-c:${d};--fx-secs:${secs}s;--fx-e:${esecs}s;--fx-ang:${fx.angle || 90}deg;--fx-bpos:${bpos}%;`
    + (fx.outline && fx.outlineWidth > 0 ? `--fx-ow:${FX_STROKE[fx.outlineWidth] || FX_STROKE[2]};--fx-oc:${fx.outline};` : '');
  const glow = shadow.length ? `text-shadow:${shadow.join(',')};` : '';
  const tail = fx.emoji ? `<span class="fx-emoji">${esc(fx.emoji)}</span>` : '';
  if (quiet) return `<span class="fx-wrap"><span class="fx-ink fx-still" style="${ink}${glow}">${esc(name)}</span>${tail}</span>`;
  const cls = ['fx-ink', 'fx-slide-' + (anim.slide || 'lr')];
  if (anim.letters) cls.push('fx-cut', 'fx-e-' + anim.letters);
  const inner = anim.letters ? fxLetters(name, esecs, anim, fx.emoji) : esc(name);
  return `<span class="fx-wrap${anim.move ? ' fx-move-' + anim.move : ''}" style="--fx-e:${esecs}s"><span class="${cls.join(' ')}" style="${ink}${glow}">${inner}</span>${anim.letters ? '' : tail}</span>`;
}

/* ---------------------------------------------------------------- the "What's new" heading
   Order Run's fxHeading (Guile, 2026-10-12: "just like on Suki"): the HEADING wears a look,
   the notes under it stay plain — a note is there to be read (Order Run's owner asked for
   that in 0.24). Only the looks readable on both themes, and only movements that keep every
   letter upright and in place: at heading size Swirl and the glitches turned "What's new"
   into rubble there. One look per heading per app open — this app redraws on every sync, and a
   heading changing colour every 30 s reads as a flicker, not a surprise. */
const FX_HEAD_OK = new Set(['shine', 'wave', 'pulse', 'breathe', 'drift', 'bulge', 'heartbeat', 'twinkle', 'sway']);
function fxNoteSafe(p){
  const hsv = p[2].map(fxHexToHsv);
  const avg = k => hsv.reduce((a, c) => a + c[k], 0) / hsv.length;
  return avg('v') >= 0.45 && avg('s') >= 0.30;
}
const fxHeadLook = {};
function fxHeading(text){
  if (!fxShown()) return esc(text);
  if (!fxHeadLook[text]){
    const pool = FX_PRESETS.filter(fxNoteSafe).filter(p => FX_HEAD_OK.has(p[4]));
    fxHeadLook[text] = pool[Math.floor(Math.random() * pool.length)] || FX_PRESETS[0];
  }
  const p = fxHeadLook[text];
  return fxMarkup(text, cleanFx({colors: p[2], glow: p[3], anim: p[4], speed: 'normal'}));
}

/* ---------------------------------------------------------------- nothing moves unseen */
// while a finger is scrolling, nothing else moves; a fifth of a second after, it carries on
(function fxQuietWhileScrolling(){
  const root = document.documentElement;
  let off = null;
  document.addEventListener('scroll', () => {
    if (!off) root.classList.add('fx-scrolling');
    clearTimeout(off);
    off = setTimeout(() => { off = null; root.classList.remove('fx-scrolling'); }, 200);
  }, {capture: true, passive: true});
})();
// off screen = paused. Every name starts paused; the observer says which ones are seen.
(function fxWatchMotion(){
  if (!('IntersectionObserver' in window) || !('MutationObserver' in window)) return;
  const eye = new IntersectionObserver(rows => rows.forEach(r => r.target.classList.toggle('fx-idle', !r.isIntersecting)), {rootMargin: '80px'});
  const take = el => { if (!el.dataset.fxSeen){ el.dataset.fxSeen = '1'; el.classList.add('fx-idle'); eye.observe(el); } };
  const sweep = root => {
    if (!root || root.nodeType !== 1) return;
    if (root.classList.contains('fx-wrap')) take(root);
    root.querySelectorAll('.fx-wrap').forEach(take);
  };
  const start = () => {
    sweep(document.body);
    new MutationObserver(list => list.forEach(m => m.addedNodes.forEach(sweep))).observe(document.body, {childList: true, subtree: true});
  };
  if (document.body) start(); else document.addEventListener('DOMContentLoaded', start);
})();
// under another screen = paused: called by drawPanels() after every redraw
function fxIdleUnder(){
  const sheets = [...document.querySelectorAll('#panels > .sheet')], top = sheets[sheets.length - 1];
  const wrap = document.querySelector('body > .wrap');
  if (wrap) wrap.classList.toggle('fx-idle', !!top);
  sheets.forEach(s => s.classList.toggle('fx-idle', s !== top));
  // the pinned preview stops under the screen's own bar — measured: it grows when its words wrap
  if (top && top.querySelector('[data-fxstage]')){
    const bar = top.querySelector('.sheet-top');
    if (bar) top.style.setProperty('--fx-top', Math.round(bar.getBoundingClientRect().height) + 'px');
  }
}

/* ---------------------------------------------------------------- the colours */
const FX_HANDLES = [['c0', '1', 'Colour 1'], ['c1', '2', 'Colour 2'], ['c2', '3', 'Colour 3'], ['glow', 'G', 'Glow'], ['outline', 'T', 'Outline']];
// white, black and the greys: a ring of hues cannot show them, so they are one tap
const FX_NEUTRALS = ['#ffffff', '#cbd5e1', '#94a3b8', '#475569', '#1e293b', '#000000'];
function fxHexToRgb(h){
  const s = String(h || '').replace('#', '');
  return [parseInt(s.slice(0, 2), 16) || 0, parseInt(s.slice(2, 4), 16) || 0,
          parseInt(s.slice(4, 6), 16) || 0];
}
function fxRgbToHex(r, g, b){
  const p = n => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0');
  return '#' + p(r) + p(g) + p(b);
}
// Hue/saturation/brightness, because that is what a wheel and a box are: the angle is the
// hue, the distance out is the saturation, and up the box is the brightness.
function fxHexToHsv(hex){
  const [r, g, b] = fxHexToRgb(hex).map(v=> v / 255);
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
  let h = 0;
  if (d){
    if (mx === r) h = ((g - b) / d) % 6;
    else if (mx === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  return {h, s: mx ? d / mx : 0, v: mx};
}
function fxHsvToHex(h, s, v){
  h = ((h % 360) + 360) % 360;
  s = Math.max(0, Math.min(1, s));
  v = Math.max(0, Math.min(1, v));
  const c = v * s, x = c * (1 - Math.abs((h / 60) % 2 - 1)), m = v - c;
  let r = 0, g = 0, b = 0;
  if (h < 60){ r = c; g = x; }
  else if (h < 120){ r = x; g = c; }
  else if (h < 180){ g = c; b = x; }
  else if (h < 240){ g = x; b = c; }
  else if (h < 300){ r = x; b = c; }
  else { r = c; b = x; }
  return fxRgbToHex((r + m) * 255, (g + m) * 255, (b + m) * 255);
}
function fxSlot(d, k){
  if (k === 'c0') return d.colors[0] || '';
  if (k === 'c1') return d.colors[1] || '';
  if (k === 'c2') return d.colors[2] || '';
  if (k === 'glow') return d.glow || '';
  return d.outline || '';
}
function fxSetSlot(d, k, hex){
  if (k.charAt(0) === 'c'){
    const i = Number(k.charAt(1)), c = d.colors.slice();
    if (hex){ while (c.length < i) c.push(c[c.length - 1] || '#ec4899'); c[i] = hex; }
    else c.length = Math.min(c.length, i);
    d.colors = c.filter(Boolean);
    if (!d.colors.length) d.colors = ['#ec4899'];   // colour 1 is never empty
    return;
  }
  if (k === 'glow'){ d.glow = hex; return; }
  d.outline = hex;
  if (!hex){ d.outlineWidth = 0; d.outlineGlow = false; }
  else if (!d.outlineWidth) d.outlineWidth = 2;
}
function fxDefaultDraft(){
  const where = {};
  FX_AREAS.forEach(([k]) => { where[k] = true; });
  return {colors: ['#ec4899', '#a855f7'], mid: 50, angle: 90, glow: '#ec4899', outline: '', outlineWidth: 0,
          outlineGlow: false, anim: 'lr', speed: 'normal', emoji: '', where};
}
function fxPresetNow(d){
  for (const [name, emoji, colors, glow, anim, outline] of FX_PRESETS)
    if (d.glow === glow && d.emoji === emoji && d.anim === anim && (d.outline || '') === outline
        && d.colors.join() === colors.join()) return name;
  return '';
}

/* ---------------------------------------------------------------- Users → a person: the box */
// The office only. The preview, and the two decisions: change it, or turn it off.
function fxMemberHtml(t){
  const name = t.display_name || (t.email || '').split('@')[0], fx = fxClean(t.name_fx);
  return `<div class="fx-group">
    <div class="menu-title">✨ Name effect ${infoBtn('namefx')}</div>
    <div class="fx-preview">${fxPreview(name, fx || FX_DEMO)}</div>
    ${fx ? '' : '<div class="fx-sample-note">A sample — nothing is set yet.</div>'}
    <button type="button" class="b wide fx-cta" data-act="namefx" data-id="${esc(t.id)}">${fx ? '✏️ Change the effect' : 'Give this name an effect'}</button>
    ${fx ? `<button type="button" class="b danger wide" data-act="namefxoff" data-id="${esc(t.id)}">Turn it off</button>` : ''}
  </div>`;
}

/* ---------------------------------------------------------------- the Name Effect screen
   Each decision is its own card, in the order it is made: look at it, take a ready-made
   one, then the colours, then the way it moves, then the emoji, then where it shows. The
   preview stays pinned at the top; Apply stays pinned at the bottom. */
const fxCard = (icon, title, blurb, inner) => `<div class="fx-card"><div class="fx-card-head">${icon} <b>${esc(title)}</b></div>
  ${blurb ? `<div class="fx-card-blurb">${esc(blurb)}</div>` : ''}${inner}</div>`;
const fxLabel = id => { const t = (db.team || {})[id] || {}; return t.display_name || (t.email || '').split('@')[0] || 'Name'; };
function fxDraftOf(p){
  if (!p.draft){
    const t = (db.team || {})[p.id] || {};
    p.had = !!fxClean(t.name_fx);
    p.draft = p.had ? JSON.parse(JSON.stringify(fxClean(t.name_fx))) : fxDefaultDraft();
  }
  return p.draft;
}
function fxPresetsHtml(d){
  const now = fxPresetNow(d);
  return fxCard('⭐', 'Ready-made', 'One tap sets the colours, the glow, the outline, the emoji and the way it moves.',
    `<div class="fx-wrapstrip">${FX_PRESETS.map(([name, emoji, colors, glow, anim, outline]) =>
      `<button type="button" class="fx-chip${name === now ? ' is-on' : ''}" data-fx="preset" data-preset="${esc(name)}">${
        fxMarkup(name, cleanFx({colors, glow, outline, outlineWidth: outline ? 1 : 0, anim, emoji}))}</button>`).join('')}</div>`);
}
function fxEmojiList(p){
  const find = String(p.emojiFind || '').trim().toLowerCase();
  const list = FX_EMOJI_GROUPS.filter(([g]) => !find || g.toLowerCase().includes(find)).reduce((all, [, l]) => all.concat(l), []);
  return list.length ? `<div class="fx-emoji-grid">${list.map(e =>
      `<button type="button" class="fx-emoji-btn${p.draft.emoji === e ? ' is-on' : ''}" data-fx="emoji" data-emoji="${esc(e)}">${e}</button>`).join('')}</div>`
    : '<div class="fx-card-blurb">Nothing by that name.</div>';
}
function fxRestHtml(p){
  const d = p.draft;
  return `${fxCard('🎨', 'Colours', 'Three for the letters, one for the glow behind them, one for the outline around them.',
      `<div class="fx-slots">${FX_HANDLES.map(([k, tag]) => { const hex = fxSlot(d, k);
        return `<button type="button" class="fx-slot${hex ? '' : ' is-off'}" style="--sw:${hex || 'transparent'}" data-fx="wheel" data-slot="${k}">
          <span class="swatch"></span><small>${esc(tag)}</small></button>`; }).join('')}</div>
      <div class="fx-card-blurb" style="margin:8px 0 0">Tap any one to open the big colour wheel.</div>`)}
    ${fxCard('🌈', 'Gradient', 'Which way the colours run, and where the middle one sits between the other two.',
      `<div class="fx-slider-row"><label for="fx_ang">Angle</label>
        <input id="fx_ang" type="range" min="0" max="350" step="10" value="${d.angle}" data-fxin="angle"><output>${d.angle}°</output></div>
      <div class="fx-slider-row"><label for="fx_mid">Spacing</label>
        <input id="fx_mid" type="range" min="10" max="90" step="5" value="${d.mid}" data-fxin="mid"><output>${d.mid}%</output></div>`)}
    ${fxCard('◻', 'Outline', 'A border around each letter. Give (T) a colour above to switch it on.',
      !d.outline ? '<div class="fx-card-blurb" style="margin:0">No outline — give (T) a colour to use one.</div>'
        : `<div class="fx-slider-row"><label for="fx_ow">Thickness</label>
            <input id="fx_ow" type="range" min="1" max="4" step="1" value="${d.outlineWidth || 2}" data-fxin="ow"><output>${d.outlineWidth || 2}</output></div>
          <button type="button" class="fx-where${d.outlineGlow ? ' is-on' : ''}" data-fx="oglow">
            <span><b>Make the outline glow too</b></span><span class="fx-tick">${d.outlineGlow ? '☑' : '☐'}</span></button>`)}
    ${fxCard('✨', 'How it moves', 'Some slide the colours along the name. Some move the letters themselves, one at a time.',
      `<div class="fx-anim-grid">${FX_ANIMS.map(([k, name, glyph]) =>
        `<button type="button" class="fx-anim-btn${d.anim === k ? ' is-on' : ''}" data-fx="anim" data-anim="${k}"><span class="glyph">${glyph}</span>${esc(name)}</button>`).join('')}</div>
      <div class="fx-slider-row" style="margin-top:10px"><label>Speed</label>
        <div class="fx-strip" style="flex:1">${[['slow', 'Slow'], ['normal', 'Normal'], ['fast', 'Fast']].map(([k, l]) =>
          `<button type="button" class="fx-chip${d.speed === k ? ' is-on' : ''}" data-fx="speed" data-speed="${k}">${l}</button>`).join('')}</div></div>`)}
    ${fxCard('😀', 'Emoji', 'One emoji, on the right of the name.',
      `<div class="fx-strip">
        <button type="button" class="fx-chip${d.emoji ? '' : ' is-on'}" data-fx="emoji" data-emoji="">None</button>
        ${FX_EMOJI_TOP.map(e => `<button type="button" class="fx-emoji-btn${d.emoji === e ? ' is-on' : ''}" data-fx="emoji" data-emoji="${esc(e)}">${e}</button>`).join('')}
        <button type="button" class="fx-chip${p.emojiOpen ? ' is-on' : ''}" data-fx="emojiall">${p.emojiOpen ? 'Close the list' : 'All of them…'}</button>
      </div>
      ${p.emojiOpen ? `<input type="search" class="fx-find" data-fxfind value="${esc(p.emojiFind || '')}" placeholder="Search: faces, animals, food, hearts…" autocomplete="off">
        <div class="fx-emoji-scroll" data-fxemojis>${fxEmojiList(p)}</div>` : ''}`)}
    ${fxCard('👁', 'Where it shows', 'The shop sees it on the screens ticked here. Customers never see it.',
      FX_AREAS.map(([k, name, blurb]) => `<button type="button" class="fx-where${d.where[k] ? ' is-on' : ''}" data-fx="where" data-area="${k}">
        <span><b>${esc(name)}</b><br><span class="fx-card-blurb">${esc(blurb)}</span></span>
        <span class="fx-tick">${d.where[k] ? '☑' : '☐'}</span></button>`).join(''))}
    <div class="fx-foot">
      <button type="button" class="b primary wide" data-fx="save">✨ Apply the effect</button>
      ${p.had ? '<button type="button" class="b danger wide" data-fx="off">Turn it off</button>' : ''}
      <div class="fx-card-blurb" style="margin:0;text-align:center">Only a colour — it changes nothing about what this person can do.</div>
    </div>`;
}
function panelNameFx(p){
  if (!db.team || !db.team[p.id]) return {title: 'Name effect', body: '<div class="cart-empty">This person is no longer on this phone.</div>'};
  const d = fxDraftOf(p);
  return {title: 'Name effect', sub: fxLabel(p.id), body: `<div class="fx-ed" data-fxed="${esc(p.id)}">
    <div class="fx-stage" data-fxstage>${fxPreview(fxLabel(p.id), d)}</div>
    <div data-fxpresets>${fxPresetsHtml(d)}</div>
    <div data-fxrest>${fxRestHtml(p)}</div></div>`};
}
// a tap: the preview and the cards under it, never the fifty looks
function fxRedraw(root, p, restToo = true){
  const stage = root.querySelector('[data-fxstage]');
  if (stage) stage.innerHTML = fxPreview(fxLabel(p.id), p.draft);
  const now = fxPresetNow(p.draft);
  root.querySelectorAll('[data-fx="preset"]').forEach(b => b.classList.toggle('is-on', b.dataset.preset === now));
  if (!restToo) return;
  const rest = root.querySelector('[data-fxrest]'), sc = root.closest('.sheet');   // the sheet is what scrolls
  const at = sc ? sc.scrollTop : 0;
  if (rest) rest.innerHTML = fxRestHtml(p);
  if (sc) sc.scrollTop = at;
}
function fxSave(id, fx){
  const t = db.team[id]; if (!t) return;
  const send = fx ? cleanFx(fx) : null;
  write('set_name_fx', {p_user: id, p_fx: send}, (send ? 'Name effect — ' : 'Name effect off — ') + (t.display_name || t.email || ''), [id], db => {
    if (db.team[id]) db.team[id].name_fx = send;
    const s = (db.staff || []).find(x => x.id === id); if (s) s.fx = send;
  });
  toast(send ? 'Effect saved — the shop sees it.' : 'Effect turned off — a plain name again, on every phone.');
}

/* ---------------------------------------------------------------- the colour wheel
   A screen of its own: five dots on a wheel the width of a thumb is a fight. The angle is the
   hue, the distance out the strength; the box under it is strength and brightness, so white,
   the greys and black are on its left edge. Dots sit by percent: no measuring. */
function fxWheelFor(p){
  const ed = stack.find(x => x.kind === 'namefx' && x.id === p.id);
  if (!ed || !ed.draft) return null;
  if (!p.hsv){
    p.hsv = {};
    FX_HANDLES.forEach(([k]) => { const hex = fxSlot(ed.draft, k); p.hsv[k] = hex ? fxHexToHsv(hex) : {h: 320, s: 0.78, v: 0.92}; });
  }
  return ed;
}
function fxWheelParts(p, d){
  const held = p.held || 'c0', cur = p.hsv[held], hex = fxSlot(d, held);
  const tag = (FX_HANDLES.find(x => x[0] === held) || [])[1] || '', what = (FX_HANDLES.find(x => x[0] === held) || [])[2] || '';
  const grips = FX_HANDLES.map(([k, t]) => { const h = fxSlot(d, k); if (!h) return '';
    const c = p.hsv[k], x = 50 + Math.sin(c.h * Math.PI / 180) * c.s * 50, y = 50 - Math.cos(c.h * Math.PI / 180) * c.s * 50;
    return `<div class="fx-grip${k === held ? ' is-held' : ''}" style="--sw:${h};left:${x.toFixed(2)}%;top:${y.toFixed(2)}%">${t}</div>`; }).join('');
  return {
    stage: fxPreview(fxLabel(p.id), d),
    slots: FX_HANDLES.map(([k, t]) => { const h = fxSlot(d, k);
      return `<button type="button" class="fx-slot${h ? '' : ' is-off'}${k === held ? ' is-on' : ''}" style="--sw:${h || 'transparent'}" data-fx="wslot" data-slot="${k}"><span class="swatch"></span><small>${t}</small></button>`; }).join(''),
    wheel: `<div class="fx-wheel-dim" style="--dim:${hex ? (1 - cur.v).toFixed(3) : 0}"></div>${grips}`,
    sbStyle: `--hue:${fxHsvToHex(cur.h, 1, 1)}`,
    sb: hex ? `<div class="fx-grip is-held" style="--sw:${hex};left:${(cur.s * 100).toFixed(2)}%;top:${((1 - cur.v) * 100).toFixed(2)}%">${tag}</div>` : '',
    hex: hex ? tag + ' · ' + hex.toUpperCase() : what + ' is off — drag on the wheel to switch it on',
    clear: held !== 'c0' && hex ? `<button type="button" class="b wide" data-fx="wclear">Turn ${esc(what)} off</button>` : '',
  };
}
function panelFxWheel(p){
  const ed = fxWheelFor(p);
  if (!ed) return {title: 'Colours', body: '<div class="cart-empty">Back, and open the name effect again.</div>'};
  const w = fxWheelParts(p, ed.draft);
  return {title: 'Colours', sub: 'Drag a dot. The box below gives white, black and grey.', body: `<div class="fx-ed fx-wheel-ed" data-fxwheeled="${esc(p.id)}">
    <div class="fx-stage" data-fxstage>${w.stage}</div>
    <div class="fx-slots" data-fxslots>${w.slots}</div>
    <div class="fx-wheel-wrap">
      <div class="fx-wheel" data-fxwheel>${w.wheel}</div>
      <div class="fx-sb" data-fxsb style="${w.sbStyle}">${w.sb}</div>
      <div class="fx-hex" data-fxhex>${esc(w.hex)}</div>
      <div class="fx-neutral-row">${FX_NEUTRALS.map(h => `<button type="button" class="fx-neutral" style="--sw:${h}" data-fx="neutral" data-hex="${h}" aria-label="${h}"></button>`).join('')}</div>
    </div>
    <div class="fx-foot"><span data-fxclear>${w.clear}</span><button type="button" class="b primary wide" data-fx="wdone">✓ Done</button></div>
  </div>`};
}
function fxWheelRedraw(root, p, ed){
  const w = fxWheelParts(p, ed.draft), set = (sel, html) => { const el = root.querySelector(sel); if (el) el.innerHTML = html; };
  set('[data-fxstage]', w.stage); set('[data-fxslots]', w.slots); set('[data-fxwheel]', w.wheel); set('[data-fxsb]', w.sb);
  set('[data-fxhex]', esc(w.hex)); set('[data-fxclear]', w.clear);
  const sb = root.querySelector('[data-fxsb]'); if (sb) sb.setAttribute('style', w.sbStyle);
}
function fxPut(p, ed, k, h, s, v){ p.hsv[k] = {h, s, v}; fxSetSlot(ed.draft, k, fxHsvToHex(h, s, v)); }

let fxDrag = null;
document.addEventListener('pointerdown', e => {
  const el = e.target.closest && e.target.closest('[data-fxwheel], [data-fxsb]');
  if (!el) return;
  const root = el.closest('[data-fxwheeled]'), p = topPanel();
  if (!root || !p || p.kind !== 'fxwheel') return;
  const ed = fxWheelFor(p); if (!ed) return;
  e.preventDefault();
  const wheel = el.matches('[data-fxwheel]');
  if (wheel){   // a thumb that lands near a dot picks that dot up
    const r = el.getBoundingClientRect(), R = r.width / 2;
    let best = '', bestD = 36;
    FX_HANDLES.forEach(([k]) => { if (!fxSlot(ed.draft, k)) return; const c = p.hsv[k];
      const d = Math.hypot(e.clientX - (r.left + R + Math.sin(c.h * Math.PI / 180) * c.s * R), e.clientY - (r.top + R - Math.cos(c.h * Math.PI / 180) * c.s * R));
      if (d < bestD){ bestD = d; best = k; } });
    if (best) p.held = best;
  }
  fxDrag = {el, wheel, root, p, ed};
  try { el.setPointerCapture(e.pointerId); } catch (_){}
  fxDragTo(e);
});
document.addEventListener('pointermove', e => { if (fxDrag) fxDragTo(e); });
['pointerup', 'pointercancel'].forEach(t => document.addEventListener(t, () => { fxDrag = null; }));
function fxDragTo(e){
  const {el, wheel, root, p, ed} = fxDrag, r = el.getBoundingClientRect(), held = p.held || 'c0', c = p.hsv[held];
  if (wheel){
    const R = r.width / 2, dx = e.clientX - (r.left + R), dy = e.clientY - (r.top + R);
    fxPut(p, ed, held, (Math.atan2(dx, -dy) * 180 / Math.PI + 360) % 360, Math.min(1, Math.hypot(dx, dy) / R), c.v);
  } else {
    fxPut(p, ed, held, c.h, Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)), Math.max(0, Math.min(1, 1 - (e.clientY - r.top) / r.height)));
  }
  fxWheelRedraw(root, p, ed);
}

/* ---------------------------------------------------------------- the taps */
document.addEventListener('click', e => {
  const b = e.target.closest && e.target.closest('[data-fx]');
  if (!b) return;
  const p = topPanel(); if (!p) return;
  const kind = b.dataset.fx;
  if (p.kind === 'fxwheel'){
    const ed = fxWheelFor(p), root = b.closest('[data-fxwheeled]'); if (!ed || !root) return;
    if (kind === 'wslot'){ p.held = b.dataset.slot;
      if (!fxSlot(ed.draft, p.held)){ const c = p.hsv[p.held]; fxPut(p, ed, p.held, c.h, c.s, c.v); } }
    else if (kind === 'neutral'){ const c = fxHexToHsv(b.dataset.hex); fxPut(p, ed, p.held || 'c0', p.hsv[p.held || 'c0'].h, c.s, c.v); }
    else if (kind === 'wclear') fxSetSlot(ed.draft, p.held || 'c0', '');
    else if (kind === 'wdone'){ closePanel(); return; }
    fxWheelRedraw(root, p, ed);
    return;
  }
  if (p.kind !== 'namefx') return;
  const root = b.closest('[data-fxed]'), d = p.draft; if (!root || !d) return;
  if (kind === 'preset'){
    const hit = FX_PRESETS.find(x => x[0] === b.dataset.preset);
    if (hit){
      d.colors = hit[2].slice(); d.emoji = hit[1]; d.glow = hit[3]; d.anim = hit[4] || 'lr';
      d.outline = hit[5] || ''; d.outlineWidth = d.outline ? (d.outlineWidth || 2) : 0;
      if (!d.outline) d.outlineGlow = false;
    }
  } else if (kind === 'wheel'){ openPanel({kind: 'fxwheel', id: p.id, held: b.dataset.slot}); return; }
  else if (kind === 'anim') d.anim = b.dataset.anim;
  else if (kind === 'speed') d.speed = b.dataset.speed;
  else if (kind === 'oglow') d.outlineGlow = !d.outlineGlow;
  else if (kind === 'emoji') d.emoji = b.dataset.emoji || '';
  else if (kind === 'emojiall'){ p.emojiOpen = !p.emojiOpen; p.emojiFind = ''; }
  else if (kind === 'where') d.where = {...d.where, [b.dataset.area]: !d.where[b.dataset.area]};
  else if (kind === 'save'){ fxSave(p.id, d); closePanel(); return; }
  else if (kind === 'off'){ if (!confirmTwice(b, 'Tap again to turn it off')) return; fxSave(p.id, null); closePanel(); return; }
  fxRedraw(root, p);
});
// the sliders repaint the name while they move; the emoji search narrows only its own list
document.addEventListener('input', e => {
  const t = e.target, p = topPanel();
  if (!p || p.kind !== 'namefx' || !p.draft || !t.closest) return;
  const root = t.closest('[data-fxed]'); if (!root) return;
  if (t.matches('[data-fxfind]')){
    p.emojiFind = t.value;
    const box = root.querySelector('[data-fxemojis]'); if (box) box.innerHTML = fxEmojiList(p);
    return;
  }
  const k = t.dataset.fxin; if (!k) return;
  const n = Number(t.value);
  if (k === 'angle') p.draft.angle = n; else if (k === 'mid') p.draft.mid = n; else if (k === 'ow') p.draft.outlineWidth = n;
  const out = t.parentNode.querySelector('output');
  if (out) out.textContent = k === 'angle' ? n + '°' : k === 'mid' ? n + '%' : String(n);
  fxRedraw(root, p, false);
});

// app.js merges these into its own tables
window.FX_PANELS = {namefx: panelNameFx, fxwheel: panelFxWheel};
window.FX_ACTIONS = {
  namefx: id => { if (db.team[id]) openPanel({kind: 'namefx', id}); },
  namefxoff: (id, el) => { if (db.team[id] && confirmTwice(el, 'Tap again to turn it off')) fxSave(id, null); },
  fxshow: (id, el) => { try { localStorage.setItem('ws_fx_off', el.dataset.v === 'off' ? '1' : '0'); } catch (_){} render(); },
};
