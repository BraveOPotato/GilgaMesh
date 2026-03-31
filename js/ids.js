// ─── HUMAN-READABLE IDS ───────────────────────────────────────────────────────
const ADJECTIVES = [
  'amber','ancient','arctic','azure','blazing','bold','brave','bright','calm','celestial',
  'cerulean','chaotic','chosen','clever','cobalt','cosmic','crimson','crystal','cunning','dark',
  'daring','dawn','deep','distant','divine','dusk','eager','electric','emerald','endless',
  'epic','eternal','fierce','fiery','fleet','frosty','gilded','glacial','golden','grand',
  'grave','grim','hollow','humble','icy','idle','indigo','infinite','inner','iron',
  'jade','keen','kindled','lantern','lavender','lean','lofty','lone','lost','lucid',
  'lunar','mellow','mighty','mystic','narrow','neon','nimble','noble','obscure','ochre',
  'odd','old','omen','onyx','pale','phantom','primal','proud','quick','quiet',
  'radiant','rapid','raven','red','regal','restless','risen','roaming','rough','royal',
  'runed','sacred','sage','scarlet','serene','shining','silent','silver','sleek','solar',
  'somber','stark','steel','stern','still','storm','strong','subtle','sunken','swift',
  'teal','terse','timeless','tired','torn','twilight','twisted','ultra','vast','velvet',
  'veiled','vivid','wandering','wild','winter','wise','woven','zeal','zenith','zeroed',
];
const NOUNS = [
  'anvil','apex','arch','arrow','atlas','axe','beacon','blade','bloom','bolt',
  'bond','breach','bridge','cairn','candle','canyon','cape','cave','chain','cipher',
  'citadel','cliff','cloud','comet','compass','conduit','core','crest','crown','current',
  'cycle','dawn','delta','depth','door','dune','dust','echo','edge','ember',
  'epoch','falls','fang','field','flame','flare','flint','flood','flux','forge',
  'fork','frost','gate','glyph','gorge','grove','guide','gulf','harbor','haven',
  'hearth','helm','horizon','horn','island','keep','key','knot','lantern','ledge',
  'light','link','loop','mantle','mark','marsh','mesa','mesh','mirror','mist',
  'moon','mount','nexus','node','notch','oak','oracle','orbit','order','path',
  'peak','pillar','pine','plain','portal','prism','pulse','range','reef','relay',
  'ridge','rift','ring','root','rune','scale','shard','shore','signal','span',
  'spire','star','stone','storm','stream','summit','sun','surge','tide','timber',
  'torch','tower','trail','vault','veil','vessel','void','vortex','wake','wall',
  'ward','wave','well','wind','wire','world','wraith','yard','zenith','zone',
];

export function generatePeerId() {
  const adj  = ADJECTIVES[Math.floor(Math.random() * ADJECTIVES.length)];
  const noun = NOUNS[Math.floor(Math.random() * NOUNS.length)];
  return `${adj}-${noun}-${String(Math.floor(Math.random() * 9000) + 1000)}`;
}

export function generateRoomId() {
  return String(Math.floor(Math.random() * 9000) + 1000);
}

export function genId() {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}
