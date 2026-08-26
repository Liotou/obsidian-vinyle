'use strict';

/*
 * Vinyle — un tourne-disque dans Obsidian.
 *
 * Le greffon interroge Music.app par AppleScript, sans clé API ni réseau, et
 * fait tourner la pochette de la piste en cours sur un disque dessiné en CSS.
 *
 * Trois règles ont guidé l'écriture :
 *   - ne jamais sonder quand personne ne regarde (ni volet, ni barre d'état) ;
 *   - n'extraire la pochette que si la piste a réellement changé, l'image
 *     pesant environ un mégaoctet ;
 *   - laisser la rotation au moteur CSS, pour qu'une lecture prolongée ne
 *     coûte rien au processeur.
 */

const obsidian = require('obsidian');
const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');

const TYPE_VUE = 'vinyle-tourne-disque';

const REGLAGES_DEFAUT = {
  cadenceLecture: 2000,   // ms entre deux interrogations pendant la lecture
  cadencePause: 6000,     // ms entre deux interrogations à l'arrêt
  masquerEnPause: false,  // retirer l'élément de barre quand rien ne joue
  formatBarre: '{{titre}} — {{artiste}}',
  longueurMaxBarre: 40,
  tailleAuto: true,       // le disque suit la taille du volet
  tailleDisque: 300,      // px, taille fixe quand tailleAuto est faux
  tailleMax: 460,         // px, plafond en taille automatique
  flottantParDefaut: false, // le ruban ouvre une fenêtre détachée
  montrerBras: true,
  montrerProgression: true,
  montrerBarreEtat: true,
  etagere: [],            // [{ type: 'liste' | 'album', nom }]
  montrerEtagere: true,
  sons: true,             // frottement, pose du saphir, retour au lit
  volumeSons: 0.5,
};

/* =========================================================================
 * Le bruiteur
 *
 * Les trois bruits du tourne-disque sont calculés, jamais enregistrés : du
 * bruit passé dans des filtres, et rien d'autre. Le greffon reste ainsi sans
 * la moindre ressource binaire, ce qui est sa règle depuis le premier jour, et
 * strictement hors ligne, ce qui est sa promesse.
 *
 * Le contexte audio ne s'ouvre qu'au premier geste et jamais au chargement :
 * aucun bruit ne peut surprendre qui n'a rien demandé.
 * ========================================================================= */

class Bruiteur {
  constructor(greffon) {
    this.greffon = greffon;
    this.ctx = null;
    this.frottement = null;
  }

  actif() { return this.greffon.reglages.sons !== false; }

  volume() {
    const v = this.greffon.reglages.volumeSons;
    return Math.max(0, Math.min(1, v == null ? 0.5 : v));
  }

  contexte() {
    if (!this.actif()) return null;
    if (this.ctx) {
      // Le navigateur suspend le contexte quand la fenêtre passe à l'arrière.
      if (this.ctx.state === 'suspended') this.ctx.resume();
      return this.ctx;
    }
    const Fabrique = window.AudioContext || window.webkitAudioContext;
    if (!Fabrique) return null;
    try { this.ctx = new Fabrique(); } catch (e) { return null; }
    // Deux secondes de bruit blanc pour les coups brefs, six secondes de
    // matière de sillon pour le frottement. Fabriquées une fois : les refaire à
    // chaque geste coûterait plus cher que le son lui-même.
    const taux = this.ctx.sampleRate;
    const n = Math.floor(taux * 2);
    this.bruit = this.ctx.createBuffer(1, n, taux);
    const d = this.bruit.getChannelData(0);
    for (let i = 0; i < n; i++) d[i] = Math.random() * 2 - 1;
    this.sillon = this.fabriquerSillon(6);
    return this.ctx;
  }

  // Un filtre passe-bas d'ordre deux, formules RBJ. Il ne sert qu'à fabriquer
  // la matière du sillon : le reste passe par les filtres du moteur audio.
  static passeBas(taux, f0, Q) {
    const w = 2 * Math.PI * f0 / taux, cw = Math.cos(w), alpha = Math.sin(w) / (2 * Q);
    const b0 = (1 - cw) / 2, b1 = 1 - cw, b2 = b0;
    const a0 = 1 + alpha, a1 = -2 * cw, a2 = 1 - alpha;
    let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
    return (x) => {
      const y = (b0 / a0) * x + (b1 / a0) * x1 + (b2 / a0) * x2
        - (a1 / a0) * y1 - (a2 / a0) * y2;
      x2 = x1; x1 = x; y2 = y1; y1 = y;
      return y;
    };
  }

  // La matière du sillon, avec son grain et ses craquements dedans. C'est elle
  // qui fait la différence avec un bruit filtré : un bruit uniforme siffle, il
  // ne crisse pas.
  fabriquerSillon(secondes) {
    const taux = this.ctx.sampleRate;
    const n = Math.floor(taux * secondes);
    const tampon = this.ctx.createBuffer(1, n, taux);
    const s = tampon.getChannelData(0);
    const alea = () => Math.random() * 2 - 1;

    // Trois échelles de modulation : la houle du sillon, sa rugosité, son grain.
    const lent = Bruiteur.passeBas(taux, 14, 0.7);
    const moyen = Bruiteur.passeBas(taux, 80, 0.9);
    const fin = Bruiteur.passeBas(taux, 300, 1.0);
    for (let i = 0; i < n; i++) {
      const m = 0.12 + 1.9 * Math.abs(lent(alea()))
        + 1.3 * Math.abs(moyen(alea())) + 1.1 * Math.abs(fin(alea()));
      s[i] = alea() * Math.min(2.2, m);
    }

    // Les craquements menus, la poussière : denses, présents partout.
    let i = 0;
    while (i < n) {
      i += Math.floor(taux * (0.0015 + Math.random() * 0.018));
      if (i >= n) break;
      const force = 0.9 + Math.random() * 2.2;
      const long = 2 + Math.floor(Math.random() * 45);
      for (let k = 0; k < long && i + k < n; k++) {
        s[i + k] += force * Math.exp(-k / (long * 0.3)) * alea();
      }
    }

    // Les grosses rayures, rares et franches : ce sont elles qu'on remarque.
    let j = 0;
    while (j < n) {
      j += Math.floor(taux * (0.10 + Math.random() * 0.42));
      if (j >= n) break;
      const force = 2.2 + Math.random() * 2.6;
      const long = 40 + Math.floor(Math.random() * 260);
      for (let k = 0; k < long && j + k < n; k++) {
        s[j + k] += force * Math.exp(-k / (long * 0.16)) * alea();
      }
    }
    return tampon;
  }

  // Saturation douce. Elle ajoute les harmoniques qui font la matière, et elle
  // écrête les craquements, ce qui les rend plus francs qu'ils ne sont.
  courbeSaturation() {
    const n = 2048, c = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const x = (i / (n - 1)) * 2 - 1;
      c[i] = Math.tanh(x * 3.4) * 0.46;
    }
    return c;
  }

  // Un coup bref : bruit filtré, attaque courte, chute exponentielle.
  impulsion(freq, type, Q, gain, attaque, chute, tampon) {
    const ctx = this.ctx, t = ctx.currentTime;
    const s = ctx.createBufferSource();
    s.buffer = tampon || this.bruit;
    const f = ctx.createBiquadFilter();
    f.type = type; f.frequency.value = freq; f.Q.value = Q;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(Math.max(0.0002, gain), t + attaque);
    g.gain.exponentialRampToValueAtTime(0.0001, t + attaque + chute);
    s.connect(f); f.connect(g); g.connect(ctx.destination);
    s.start(t);
    s.stop(t + attaque + chute + 0.05);
  }

  /* --- Le frottement, pendant qu'on déplace le bras --- */

  ouvrirFrottement() {
    const ctx = this.contexte();
    if (!ctx || this.frottement) return;

    const src = ctx.createBufferSource();
    src.buffer = this.sillon;
    src.loop = true;

    // Trois voies pour un même matériau : le corps, le crissement, le grondement.
    const bande = ctx.createBiquadFilter();
    bande.type = 'bandpass'; bande.frequency.value = 1500; bande.Q.value = 0.9;
    const haut = ctx.createBiquadFilter();
    haut.type = 'highpass'; haut.frequency.value = 2600; haut.Q.value = 0.8;
    const grave = ctx.createBiquadFilter();
    grave.type = 'lowpass'; grave.frequency.value = 240; grave.Q.value = 0.8;

    const gBande = ctx.createGain(); gBande.gain.value = 0.5;
    const gHaut = ctx.createGain(); gHaut.gain.value = 0;
    const gGrave = ctx.createGain(); gGrave.gain.value = 0.45;

    const saturation = ctx.createWaveShaper();
    saturation.curve = this.courbeSaturation();
    saturation.oversample = '2x';

    const g = ctx.createGain();
    g.gain.value = 0.0001;

    src.connect(bande); bande.connect(gBande); gBande.connect(saturation);
    src.connect(haut); haut.connect(gHaut); gHaut.connect(saturation);
    src.connect(grave); grave.connect(gGrave); gGrave.connect(saturation);
    saturation.connect(g);
    g.connect(ctx.destination);
    src.start();
    this.frottement = { src, gBande, gHaut, g };
  }

  // v va de 0, immobile, à 1, geste vif. Ce n'est pas le volume qui porte la
  // vitesse mais la hauteur : on relit la matière plus ou moins vite, comme le
  // saphir traverse les sillons. Un vrai scratch change de hauteur, il ne se
  // contente pas de monter en volume.
  reglerFrottement(v) {
    if (!this.frottement || !this.ctx) return;
    const t = this.ctx.currentTime;
    const k = Math.max(0, Math.min(1, v));
    const f = this.frottement;
    f.src.playbackRate.setTargetAtTime(0.45 + 1.95 * k, t, 0.03);
    f.gBande.gain.setTargetAtTime(0.5 + 0.45 * k, t, 0.05);
    f.gHaut.gain.setTargetAtTime(0.6 * k, t, 0.05);
    f.g.gain.setTargetAtTime(0.85 * k * this.volume(), t, 0.04);
    // Main immobile : aucun événement ne vient, et le bruit resterait au dernier
    // niveau. On le fait donc retomber de lui-même.
    if (this.minuteurFrottement) window.clearTimeout(this.minuteurFrottement);
    this.minuteurFrottement = window.setTimeout(() => {
      if (this.frottement) this.frottement.g.gain.setTargetAtTime(0, this.ctx.currentTime, 0.05);
    }, 90);
  }

  fermerFrottement() {
    if (this.minuteurFrottement) window.clearTimeout(this.minuteurFrottement);
    const f = this.frottement;
    if (!f || !this.ctx) return;
    this.frottement = null;
    f.g.gain.setTargetAtTime(0, this.ctx.currentTime, 0.03);
    window.setTimeout(() => {
      try { f.src.stop(); f.src.disconnect(); f.g.disconnect(); } catch (e) { /* déjà fini */ }
    }, 250);
  }

  /* --- Les deux coups --- */

  // Le saphir se pose : un choc mat, le poids du bras derrière, puis le sillon
  // qui s'installe.
  poserSaphir() {
    if (!this.contexte()) return;
    const v = this.volume();
    this.impulsion(900, 'lowpass', 0.7, 0.9 * v, 0.004, 0.10);
    this.impulsion(120, 'lowpass', 0.9, 0.8 * v, 0.008, 0.18);
    this.impulsion(1900, 'bandpass', 2.2, 0.14 * v, 0.06, 0.45, this.sillon);
  }

  // Le bras revient dans son lit : plus sec, plus haut, sans corps. C'est du
  // plastique sur du plastique, pas un saphir sur un sillon.
  reposerBras() {
    if (!this.contexte()) return;
    const v = this.volume();
    this.impulsion(2600, 'bandpass', 1.6, 0.7 * v, 0.002, 0.05);
    this.impulsion(420, 'lowpass', 0.8, 0.45 * v, 0.003, 0.09);
  }

  fermer() {
    this.fermerFrottement();
    if (!this.ctx) return;
    const ctx = this.ctx;
    this.ctx = null;
    try { ctx.close(); } catch (e) { /* déjà fermé */ }
  }
}

/* =========================================================================
 * Le pont vers Music.app
 * ========================================================================= */

// Une seule interrogation renvoie tout ce dont la vue a besoin, séparé par des
// tabulations. On évite ainsi cinq appels osascript là où un seul suffit.
const SCRIPT_ETAT = `
tell application "Music"
  if it is not running then return "absent"
  set e to (player state as text)
  if e is "stopped" then return "arret"
  set p to current track
  set pochette to "0"
  try
    if (count of artworks of p) > 0 then set pochette to "1"
  end try
  return e & tab & (persistent ID of p) & tab & (name of p) & tab & ¬
    (artist of p) & tab & (album of p) & tab & (player position as text) & tab & ¬
    (duration of p as text) & tab & pochette
end tell
`;

// Les nombres reviennent dans la langue du système : « 125,501998 » en
// français. Un parseFloat direct s'arrêterait à la virgule et renverrait 125,
// silencieusement. D'où la normalisation.
function nombreLocal(x) {
  const n = parseFloat(String(x == null ? '' : x).trim().replace(',', '.'));
  return isFinite(n) ? n : 0;
}

function osascript(args, delaiMs) {
  return new Promise((resoudre) => {
    let fini = false;
    const enfant = execFile('osascript', args, { timeout: delaiMs || 5000, maxBuffer: 1 << 20 },
      (err, sortie, erreur) => {
        if (fini) return;
        fini = true;
        if (err) { resoudre({ erreur: String((erreur || err.message || '')).trim() }); return; }
        resoudre({ texte: String(sortie || '').trim() });
      });
    // Garde-fou : si osascript se bloque sur une boîte de dialogue système,
    // on ne laisse pas le processus vivre indéfiniment.
    setTimeout(() => { if (!fini) { try { enfant.kill('SIGKILL'); } catch (e) { /* déjà mort */ } } },
      (delaiMs || 5000) + 500);
  });
}

// Renvoie null si Music.app est absent ou arrêté, sinon l'état de la piste.
async function lireEtat() {
  const r = await osascript(['-e', SCRIPT_ETAT]);
  if (r.erreur) return { panne: r.erreur };
  const t = r.texte;
  if (t === 'absent' || t === 'arret' || !t) return { etat: t === 'absent' ? 'absent' : 'arret' };
  const c = t.split('\t');
  if (c.length < 8) return { etat: 'arret' };
  return {
    etat: c[0] === 'playing' ? 'lecture' : 'pause',
    id: c[1],
    titre: c[2],
    artiste: c[3],
    album: c[4],
    position: nombreLocal(c[5]),
    duree: nombreLocal(c[6]),
    pochette: c[7] === '1',
  };
}

// Les pochettes ne sont pas toutes du même format : la piste en cours est
// arrivée en PNG, celles de la bibliothèque en JPEG. Fabriquer une URL en
// « data:image/png » en dur produisait un type menteur. On lit les octets.
function typeImage(octets) {
  if (!octets || octets.length < 4) return null;
  if (octets[0] === 0x89 && octets[1] === 0x50 && octets[2] === 0x4e) return 'image/png';
  if (octets[0] === 0xff && octets[1] === 0xd8 && octets[2] === 0xff) return 'image/jpeg';
  return null;
}

function urlDonnees(chemin) {
  try {
    const octets = fs.readFileSync(chemin);
    const type = typeImage(octets);
    if (!type) return null;
    return 'data:' + type + ';base64,' + octets.toString('base64');
  } catch (e) {
    return null;
  }
}

// sips est livré avec macOS : pas de dépendance à installer. Une pochette de
// 800 pixels tombe à une vingtaine de kilooctets, ce qui compte quand
// l'étagère en porte vingt.
function reduire(chemin, cote) {
  return new Promise((resoudre) => {
    execFile('sips', ['-Z', String(cote), chemin, '--out', chemin], { timeout: 6000 },
      (err) => resoudre(!err));
  });
}

// Extrait la pochette de la piste en cours vers un fichier. Music.app ne sait
// pas cibler une piste par identifiant sans la sélectionner, on prend donc
// « current track », ce qui suffit puisqu'on n'appelle ceci qu'au changement.
async function extrairePochette(cheminAbsolu, specificateur) {
  const source = specificateur || 'current track';
  const script = `
tell application "Music" to set d to raw data of artwork 1 of ${source}
set f to open for access POSIX file ${JSON.stringify(cheminAbsolu)} with write permission
set eof f to 0
write d to f
close access f
return "ok"
`;
  const r = await osascript(['-e', script], 8000);
  return !r.erreur && r.texte === 'ok';
}

function echapperAS(x) {
  return '"' + String(x == null ? '' : x).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
}

function commander(ordre) {
  const verbes = {
    lecture: 'playpause',
    jouer: 'play',
    pause: 'pause',
    suivant: 'next track',
    precedent: 'previous track',
    arret: 'stop',
  };
  const v = verbes[ordre];
  if (!v) return Promise.resolve(false);
  return osascript(['-e', `tell application "Music" to ${v}`], 4000)
    .then((r) => !r.erreur);
}

// Music renvoie ses nombres dans la langue du système, « 125,501998 », mais
// n'accepte qu'un point dans le script qu'on lui soumet : une virgule y est une
// erreur de syntaxe. L'asymétrie est silencieuse, le déplacement échouait sans
// rien dire. toFixed produit toujours un point, quel que soit le système.
function positionner(secondes) {
  const v = Math.max(0, Number(secondes) || 0).toFixed(3);
  return osascript(['-e', 'tell application "Music" to set player position to ' + v], 4000)
    .then((r) => !r.erreur);
}

/* --------------------------- L'étagère ---------------------------------- */

// Où trouver la pochette qui représente une entrée de l'étagère : une liste ou
// un album n'ont pas d'illustration propre, on prend celle de leur première
// piste.
function specificateurDe(item) {
  if (item.type === 'liste') return '(first track of playlist named ' + echapperAS(item.nom) + ')';
  return '(first track of library playlist 1 whose album is ' + echapperAS(item.nom) + ')';
}

function ordreDeLecture(item) {
  if (item.type === 'liste') return 'play playlist named ' + echapperAS(item.nom);
  return 'play (first track of library playlist 1 whose album is ' + echapperAS(item.nom) + ')';
}

function cleItem(item) {
  const s = item.type + '\u0000' + item.nom;
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0;
  return item.type + '-' + h.toString(16);
}

async function listerListes() {
  // On écarte les listes vides, qui ne donneraient pas de pochette, et les
  // listes de clips que Music fabrique tout seul.
  const r = await osascript(['-e',
    'set out to ""\n'
    + 'tell application "Music"\n'
    + '  repeat with p in user playlists\n'
    + '    try\n'
    + '      if (count of tracks of p) > 0 then set out to out & (name of p) & linefeed\n'
    + '    end try\n'
    + '  end repeat\n'
    + 'end tell\n'
    + 'return out'], 20000);
  if (r.erreur) return [];
  return r.texte.split('\n').map((x) => x.trim()).filter(Boolean)
    .map((nom) => ({ type: 'liste', nom }));
}

async function listerAlbums() {
  const r = await osascript(['-e',
    'tell application "Music" to set a to (album of every track of library playlist 1)\n'
    + 'set u to {}\n'
    + 'repeat with x in a\n'
    + '  set v to x as text\n'
    + '  if v is not "" and u does not contain v then set end of u to v\n'
    + 'end repeat\n'
    + 'set text item delimiters to linefeed\n'
    + 'return u as text'], 30000);
  if (r.erreur) return [];
  return r.texte.split('\n').map((x) => x.trim()).filter(Boolean)
    .map((nom) => ({ type: 'album', nom }));
}

/* --------------------------- Les pistes d'un disque --------------------- */

// Où trouver l'ensemble des pistes d'une entrée de l'étagère. Pour une liste on
// garde la liste elle-même : jouer « track N of playlist » laisse Music
// enchaîner la suite tout seul, ce qu'aucune autre formulation ne permet.
function conteneurDe(item) {
  if (item.type === 'liste') return '(first user playlist whose name is ' + echapperAS(item.nom) + ')';
  return '(library playlist 1)';
}

function filtreDe(item) {
  if (item.type === 'liste') return '';
  return ' whose album is ' + echapperAS(item.nom);
}

// Trois blocs plutôt qu'une boucle : une boucle sur 933 pistes met plusieurs
// secondes là où trois « every track » sortent en 200 ms, quelle que soit la
// taille de la liste. Mesuré sur 933 pistes : 199 ms.
//
// Réserve assumée : un titre contenant un retour à la ligne décalerait les
// blocs. On le détecte en comparant leurs longueurs, et on renonce plutôt que
// d'afficher des artistes décalés d'un cran.
async function listerPistes(item) {
  const cible = 'every track of ' + conteneurDe(item) + filtreDe(item);
  const r = await osascript(['-e',
    'tell application "Music"\n'
    + '  set t to (name of ' + cible + ')\n'
    + '  set a to (artist of ' + cible + ')\n'
    + '  set d to (database ID of ' + cible + ')\n'
    + '  set q to (persistent ID of ' + cible + ')\n'
    + 'end tell\n'
    + 'set text item delimiters to linefeed\n'
    + 'set s to (character id 1)\n'
    + 'return (t as text) & s & (a as text) & s & (d as text) & s & (q as text)'], 20000);
  if (r.erreur) return { erreur: r.erreur };
  const blocs = r.texte.split('\u0001');
  if (blocs.length !== 4) return { erreur: 'réponse illisible' };
  const titres = blocs[0].split('\n');
  const artistes = blocs[1].split('\n');
  const bases = blocs[2].split('\n');
  const persistants = blocs[3].split('\n');
  if (titres.length !== artistes.length || titres.length !== bases.length
    || titres.length !== persistants.length) {
    return { erreur: 'un titre contient un retour à la ligne' };
  }
  if (titres.length === 1 && !titres[0].trim()) return { pistes: [] };
  return {
    pistes: titres.map((t, i) => ({
      rang: i + 1,                          // position dans la liste, base 1
      titre: t.trim(),
      artiste: (artistes[i] || '').trim(),
      base: (bases[i] || '').trim(),        // database ID, pour désigner la piste
      // L'identifiant persistant est le seul que l'état de Music renvoie : sans
      // lui on ne saurait pas reconnaître, parmi les morceaux de la galerie,
      // celui qui est réellement sur la platine.
      pid: (persistants[i] || '').trim(),
    })),
  };
}

// Le spécificateur d'une piste précise, pour la jouer ou en tirer la pochette.
// Une liste se désigne par le rang, ce qui donne à Music le contexte de la
// liste et donc l'enchaînement. Un album n'ayant pas de contexte jouable, on
// passe par le database ID, seul identifiant stable de la bibliothèque.
function specificateurPiste(item, piste) {
  if (item.type === 'liste') {
    return 'track ' + piste.rang + ' of ' + conteneurDe(item);
  }
  return '(first track of library playlist 1 whose database ID is ' + piste.base + ')';
}

function jouerPiste(item, piste) {
  return osascript(['-e',
    'tell application "Music" to play ' + specificateurPiste(item, piste)], 8000)
    .then((r) => !r.erreur);
}

function jouerItem(item) {
  return osascript(['-e', 'tell application "Music" to ' + ordreDeLecture(item)], 8000)
    .then((r) => !r.erreur);
}

function duree(secondes) {
  const s = Math.max(0, Math.floor(secondes || 0));
  return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
}

module.exports = class GreffonVinyle extends obsidian.Plugin {
  async onload() {
    this.reglages = Object.assign({}, REGLAGES_DEFAUT, await this.loadData());
    this.piste = null;          // dernier état connu
    this.idPochette = null;     // identifiant de la piste dont la pochette est sur le disque
    this.urlPochette = null;
    this.minuteur = null;
    this.pannesignalee = false;
    this.cachePochettes = {};
    this.cachePistes = {};     // pistes par disque, une interrogation suffit
    this.attente = [];         // file des pochettes à tirer, un seul fil
    this.fileActive = false;
    if (!Array.isArray(this.reglages.etagere)) this.reglages.etagere = [];

    this.bruiteur = new Bruiteur(this);
    this.flottant = new PanneauFlottant(this);

    this.registerView(TYPE_VUE, (feuille) => new VueVinyle(feuille, this));

    this.addRibbonIcon('disc-3', 'Vinyle', () => this.ouvrirVue());

    this.addCommand({
      id: 'ouvrir',
      name: 'Vinyle : ouvrir le tourne-disque',
      callback: () => this.ouvrirVue(),
    });
    this.addCommand({
      id: 'ouvrir-flottant',
      name: 'Vinyle : afficher ou masquer le panneau flottant',
      callback: () => this.flottant.basculer(),
    });
    this.addCommand({
      id: 'garnir-etagere',
      name: "Vinyle : ajouter un disque à l'étagère",
      callback: () => new SelecteurDisque(this.app, this).open(),
    });
    this.addCommand({
      id: 'lecture-pause',
      name: 'Vinyle : lecture ou pause',
      callback: () => commander('lecture').then(() => this.battre(true)),
    });
    this.addCommand({
      id: 'suivant',
      name: 'Vinyle : piste suivante',
      callback: () => commander('suivant').then(() => this.battre(true)),
    });
    this.addCommand({
      id: 'precedent',
      name: 'Vinyle : piste précédente',
      callback: () => commander('precedent').then(() => this.battre(true)),
    });

    this.addSettingTab(new OngletVinyle(this.app, this));

    if (this.reglages.montrerBarreEtat) this.creerBarreEtat();
    this.replanifier();
  }

  onunload() {
    if (this.minuteur) window.clearTimeout(this.minuteur);
    this.minuteur = null;
    if (this.bruiteur) this.bruiteur.fermer();
    // Un panneau en position fixe survivrait au déchargement s'il n'était pas
    // retiré ici : il est posé sur document.body, pas sur un conteneur géré.
    if (this.flottant) this.flottant.fermer();
  }

  async sauver() {
    await this.saveData(this.reglages);
  }

  /* --- Volet --- */

  async ouvrirVue(flottant) {
    const veutFlottant = flottant === undefined ? this.reglages.flottantParDefaut : flottant;
    if (veutFlottant) { this.flottant.ouvrir(); return; }
    const existantes = this.app.workspace.getLeavesOfType(TYPE_VUE);
    if (existantes.length) { this.app.workspace.revealLeaf(existantes[0]); return; }
    const feuille = this.app.workspace.getRightLeaf(false);
    if (!feuille) return;
    await feuille.setViewState({ type: TYPE_VUE, active: true });
    this.app.workspace.revealLeaf(feuille);
  }

  vues() {
    return this.app.workspace.getLeavesOfType(TYPE_VUE)
      .map((f) => f.view)
      .filter((v) => v instanceof VueVinyle);
  }

  // Tous les rendus vivants, volet comme panneau flottant.
  platines() {
    const out = [];
    for (const v of this.vues()) if (v.platine) out.push(v.platine);
    if (this.flottant && this.flottant.platine) out.push(this.flottant.platine);
    return out;
  }

  /* --- Barre d'état --- */

  creerBarreEtat() {
    if (this.barre) return;
    this.barre = this.addStatusBarItem();
    this.barre.addClass('vinyle-barre');
    this.barre.setAttribute('aria-label', 'Vinyle');
    this.disqueBarre = this.barre.createSpan({ cls: 'vinyle-barre-disque' });
    this.texteBarre = this.barre.createSpan({ cls: 'vinyle-barre-texte' });
    const cmds = this.barre.createSpan({ cls: 'vinyle-barre-commandes' });
    this.btnPrecBarre = this.boutonBarre(cmds, 'skip-back', 'Piste précédente', 'precedent');
    this.btnJouerBarre = this.boutonBarre(cmds, 'play', 'Lecture ou pause', 'lecture');
    this.btnSuivBarre = this.boutonBarre(cmds, 'skip-forward', 'Piste suivante', 'suivant');
    this.registerDomEvent(this.barre, 'click', () => this.ouvrirVue());
  }

  // Toute la barre ouvre le volet : sans arrêter la propagation, chaque
  // commande le ferait aussi.
  boutonBarre(parent, icone, infobulle, ordre) {
    const b = parent.createSpan({ cls: 'vinyle-barre-bouton' });
    obsidian.setIcon(b, icone);
    b.setAttribute('aria-label', infobulle);
    b.setAttribute('role', 'button');
    this.registerDomEvent(b, 'click', async (e) => {
      e.stopPropagation();
      await commander(ordre);
      this.battre(true);
    });
    return b;
  }

  detruireBarreEtat() {
    if (!this.barre) return;
    this.barre.remove();
    this.barre = null;
    this.disqueBarre = null;
    this.texteBarre = null;
    this.btnPrecBarre = null;
    this.btnJouerBarre = null;
    this.btnSuivBarre = null;
  }

  /* --- Sondage --- */

  // Personne ne regarde : ni volet ouvert, ni élément de barre. On se tait
  // complètement plutôt que de tourner pour rien.
  quelquUnRegarde() {
    return this.vues().length > 0 || !!(this.flottant && this.flottant.el) || !!this.barre;
  }

  replanifier() {
    if (this.minuteur) window.clearTimeout(this.minuteur);
    if (!this.quelquUnRegarde()) { this.minuteur = null; return; }
    const joue = this.piste && this.piste.etat === 'lecture';
    const delai = joue ? this.reglages.cadenceLecture : this.reglages.cadencePause;
    this.minuteur = window.setTimeout(() => this.battre(), Math.max(500, delai));
  }

  async battre(immediat) {
    if (this.minuteur) { window.clearTimeout(this.minuteur); this.minuteur = null; }
    if (!this.quelquUnRegarde()) return;
    if (immediat) await new Promise((r) => setTimeout(r, 250)); // laisser Music.app appliquer l'ordre

    const etat = await lireEtat();

    if (etat.panne) {
      this.signalerPanne(etat.panne);
      this.piste = null;
    } else {
      this.pannesignalee = false;
      this.piste = (etat.etat === 'absent' || etat.etat === 'arret') ? { etat: etat.etat } : etat;
      if (this.piste.id && this.piste.pochette && this.piste.id !== this.idPochette) {
        await this.rafraichirPochette(this.piste.id);
      }
      if (this.piste.id && !this.piste.pochette) {
        this.idPochette = this.piste.id;
        this.urlPochette = null;
      }
    }

    this.peindre();
    this.replanifier();
  }

  // La permission d'automatisation se refuse une fois pour toutes dans les
  // Réglages système. Répéter la notification à chaque battement serait une
  // punition, on ne la montre donc qu'une fois par session.
  signalerPanne(message) {
    if (this.pannesignalee) return;
    this.pannesignalee = true;
    const refus = /not allowed|autorisation|permission|-1743/i.test(message);
    new obsidian.Notice(refus
      ? "Vinyle : Obsidian n'a pas l'autorisation de piloter Music. Réglages système → Confidentialité et sécurité → Automatisation → Obsidian → Musique."
      : 'Vinyle : Music est injoignable. ' + message, refus ? 12000 : 6000);
  }

  cheminPochette(nom) {
    const rel = this.app.vault.configDir + '/plugins/' + this.manifest.id
      + '/pochettes/' + (nom || 'courante');
    const base = (this.app.vault.adapter && this.app.vault.adapter.basePath) || '';
    return { rel, abs: base ? path.join(base, rel) : null };
  }

  /* ------------------------------ Étagère ------------------------------ */

  // Les pochettes de l'étagère sont conservées sur le disque et en mémoire :
  // vingt disques à deux cents millisecondes l'extraction feraient quatre
  // secondes d'attente à chaque ouverture du volet.
  async pochetteEtagere(item) {
    const cle = cleItem(item);
    if (Object.prototype.hasOwnProperty.call(this.cachePochettes, cle)) return this.cachePochettes[cle];
    const c = this.cheminPochette(cle);
    if (!c.abs) return null;
    if (!fs.existsSync(c.abs)) {
      try { fs.mkdirSync(path.dirname(c.abs), { recursive: true }); } catch (e) { /* déjà là */ }
      const ok = await extrairePochette(c.abs, specificateurDe(item));
      if (!ok) { this.cachePochettes[cle] = null; return null; }
      await reduire(c.abs, 240);
    }
    const u = urlDonnees(c.abs);
    this.cachePochettes[cle] = u;
    return u;
  }

  /* --- Les pistes d'un disque, et leurs pochettes --- */

  // Les pistes ne coûtent qu'une interrogation, 200 ms quelle que soit la
  // taille de la liste. On les garde en mémoire pour que rouvrir une pochette
  // soit instantané.
  async pistesDe(item) {
    const cle = cleItem(item);
    if (this.cachePistes[cle]) return this.cachePistes[cle];
    const r = await listerPistes(item);
    if (r.erreur) return r;
    this.cachePistes[cle] = r;
    return r;
  }

  // Une pochette coûte 200 ms. Sur une liste de 351 titres, les tirer toutes
  // ferait plus d'une minute d'attente : on n'en demande donc que ce qui est
  // sous les yeux, une à la fois, et on abandonne la file dès que l'utilisateur
  // change de disque.
  enfiler(tache) {
    return new Promise((res) => {
      this.attente.push({ tache, res });
      this.viderFile();
    });
  }

  async viderFile() {
    if (this.fileActive) return;
    this.fileActive = true;
    while (this.attente.length) {
      const { tache, res } = this.attente.shift();
      let v = null;
      try { v = await tache(); } catch (e) { v = null; }
      res(v);
    }
    this.fileActive = false;
  }

  // Les demandes déjà en file ne servent plus quand on quitte un disque. Celle
  // qui est en cours d'exécution va jusqu'au bout : la tuer laisserait un
  // fichier de pochette à moitié écrit.
  viderAttente() {
    for (const { res } of this.attente) res(null);
    this.attente = [];
  }

  async pochettePiste(item, piste) {
    const cle = cleItem(item) + '-' + piste.base;
    if (Object.prototype.hasOwnProperty.call(this.cachePochettes, cle)) return this.cachePochettes[cle];
    const c = this.cheminPochette(cle);
    if (!c.abs) return null;
    if (!fs.existsSync(c.abs)) {
      try { fs.mkdirSync(path.dirname(c.abs), { recursive: true }); } catch (e) { /* déjà là */ }
      const ok = await extrairePochette(c.abs, specificateurPiste(item, piste));
      if (!ok) {
        // Vérifié : quand la pochette manque, le script échoue avant d'ouvrir
        // le fichier et ne laisse rien. Le ménage couvre l'autre cas, celui
        // d'une écriture interrompue, qui laisserait un fichier vide pris pour
        // une pochette au prochain affichage.
        try { fs.unlinkSync(c.abs); } catch (e) { /* rien à retirer */ }
        this.cachePochettes[cle] = null;
        return null;
      }
      await reduire(c.abs, 160);
    }
    const u = urlDonnees(c.abs);
    this.cachePochettes[cle] = u;
    return u;
  }

  async poserPiste(item, piste) {
    const ok = await jouerPiste(item, piste);
    if (!ok) {
      new obsidian.Notice('Vinyle : impossible de lancer « ' + piste.titre + ' ».');
      return false;
    }
    await this.battre(true);
    return true;
  }

  async ajouterEtagere(item) {
    const cle = cleItem(item);
    if (this.reglages.etagere.some((x) => cleItem(x) === cle)) {
      new obsidian.Notice('Vinyle : « ' + item.nom + ' » est déjà sur l\'étagère.');
      return;
    }
    this.reglages.etagere.push({ type: item.type, nom: item.nom });
    await this.sauver();
    await this.pochetteEtagere(item);
    for (const platine of this.platines()) platine.rendreEtagere();
  }

  async retirerEtagere(item) {
    const cle = cleItem(item);
    this.reglages.etagere = this.reglages.etagere.filter((x) => cleItem(x) !== cle);
    await this.sauver();
    // On garde le fichier : le disque est bon marché, et le remettre sur
    // l'étagère sera instantané.
    for (const platine of this.platines()) platine.rendreEtagere();
  }

  async poserDisque(item) {
    const ok = await jouerItem(item);
    if (!ok) {
      new obsidian.Notice('Vinyle : impossible de lancer « ' + item.nom + ' ».');
      return;
    }
    await this.battre(true);
  }

  async rafraichirPochette(id) {
    const c = this.cheminPochette();
    if (!c.abs) return;
    try { fs.mkdirSync(path.dirname(c.abs), { recursive: true }); } catch (e) { /* déjà là */ }
    const ok = await extrairePochette(c.abs);
    this.idPochette = id;
    if (!ok) { this.urlPochette = null; return; }
    // On lit le fichier pour en faire une URL de données. Passer par
    // getResourcePath obligerait à déjouer le cache, le nom étant constant, et
    // rien ne garantit qu'un chemin sous .obsidian y soit servi. Une pochette
    // pèse environ un mégaoctet et n'est relue qu'au changement de piste.
    this.urlPochette = urlDonnees(c.abs);
  }

  /* --- Rendu --- */

  texteDeBarre() {
    const p = this.piste;
    if (!p || !p.titre) return '';
    let t = String(this.reglages.formatBarre || '{{titre}}')
      .replace(/\{\{titre\}\}/g, p.titre || '')
      .replace(/\{\{artiste\}\}/g, p.artiste || '')
      .replace(/\{\{album\}\}/g, p.album || '')
      .trim();
    const max = Math.max(6, this.reglages.longueurMaxBarre || 40);
    if (t.length > max) t = t.slice(0, max - 1).trimEnd() + '…';
    return t;
  }

  peindre() {
    const p = this.piste;
    const joue = !!(p && p.etat === 'lecture');

    if (this.barre) {
      const texte = this.texteDeBarre();
      const cacher = this.reglages.masquerEnPause && !joue;
      this.barre.toggleClass('vinyle-cache', cacher || !texte);
      if (this.texteBarre) this.texteBarre.setText(texte);
      if (this.disqueBarre) this.disqueBarre.toggleClass('vinyle-tourne', joue);
      if (this.btnJouerBarre) obsidian.setIcon(this.btnJouerBarre, joue ? 'pause' : 'play');
      this.barre.setAttribute('aria-label', texte || 'Vinyle');
    }

    for (const platine of this.platines()) platine.peindre(p, this.urlPochette);
  }
};

/* -------------------------------------------------------------------------
 * Géométrie du bras.
 *
 * Les angles sont ceux de la course réelle du saphir sur le disque : levé,
 * hors du plateau ; début, sur le bord extérieur ; fin, près de l'étiquette.
 * Le pivot est exprimé en fraction du côté du plateau et découle des valeurs
 * de « .vinyle-bras » dans styles.css (top, right, width, transform-origin) :
 * toucher à l'une sans l'autre décalerait la prise du bras.
 * ------------------------------------------------------------------------- */

const BRAS_LEVE = -26;
const BRAS_DEBUT = 2;
const BRAS_FIN = 24;
const BRAS_SEUIL_POSE = -3;   // en deçà, le bras est considéré comme relevé
const BRAS_PIVOT_X = 0.91;
const BRAS_PIVOT_Y = 0.026;

function angleDeProgression(part) {
  const p = Math.max(0, Math.min(1, part || 0));
  return BRAS_DEBUT + p * (BRAS_FIN - BRAS_DEBUT);
}

function progressionDeAngle(angle) {
  return Math.max(0, Math.min(1, (angle - BRAS_DEBUT) / (BRAS_FIN - BRAS_DEBUT)));
}

/* =========================================================================
 * La platine : le rendu du disque, indépendant de son contenant
 *
 * Deux hôtes s'en servent, le volet et le panneau flottant. Sans cette
 * séparation, il faudrait écrire deux fois le disque, les commandes et le
 * calcul de taille, et les deux copies divergeraient à la première retouche.
 * ========================================================================= */

class Platine {
  constructor(greffon, conteneur) {
    this.greffon = greffon;
    this.el = conteneur;
    this.evenements = [];
    this.tailleAppliquee = null;
  }

  ecouter(cible, type, fn) {
    cible.addEventListener(type, fn);
    this.evenements.push([cible, type, fn]);
  }

  monter() {
    const c = this.el;
    c.empty();
    c.addClass('vinyle-vue');

    this.plateau = c.createDiv({ cls: 'vinyle-plateau' });
    this.bras = this.plateau.createDiv({ cls: 'vinyle-bras' });
    this.bras.innerHTML =
      '<svg viewBox="0 0 40 150" aria-hidden="true">'
      + '<circle cx="20" cy="14" r="11" class="vinyle-pivot"/>'
      + '<rect x="17" y="12" width="6" height="112" rx="3" class="vinyle-tige"/>'
      + '<rect x="12" y="120" width="16" height="22" rx="3" class="vinyle-cellule"/>'
      // Zone de prise invisible : le bras dessiné est trop fin pour être
      // attrapé confortablement à la souris.
      + '<rect x="6" y="2" width="28" height="148" class="vinyle-prise"/>'
      + '</svg>';
    this.bras.setAttribute('aria-label', 'Bras de lecture : glissez pour vous déplacer dans le morceau');

    // La translation d'échange vit sur le porteur, la rotation sur le disque :
    // une seule transform par élément, sinon l'une écrase l'autre.
    this.porteur = this.plateau.createDiv({ cls: 'vinyle-porte-disque' });
    this.disque = this.porteur.createDiv({ cls: 'vinyle-disque' });
    this.pochette = this.disque.createDiv({ cls: 'vinyle-pochette' });
    this.etiquette = this.disque.createDiv({ cls: 'vinyle-etiquette' });
    this.trou = this.disque.createDiv({ cls: 'vinyle-trou' });

    // Sous le plateau et non par-dessus : au-dessus du disque, elles
    // interceptaient la souris et gênaient la prise du bras.
    this.commandes = c.createDiv({ cls: 'vinyle-commandes' });
    this.btnPrec = this.bouton(this.commandes, 'skip-back', 'Piste précédente', 'precedent');
    this.btnJouer = this.bouton(this.commandes, 'play', 'Lecture ou pause', 'lecture');
    this.btnJouer.addClass('vinyle-bouton-principal');
    this.btnSuiv = this.bouton(this.commandes, 'skip-forward', 'Piste suivante', 'suivant');

    this.infos = c.createDiv({ cls: 'vinyle-infos' });
    this.elTitre = this.infos.createDiv({ cls: 'vinyle-titre' });
    this.elArtiste = this.infos.createDiv({ cls: 'vinyle-artiste' });
    this.elAlbum = this.infos.createDiv({ cls: 'vinyle-album' });

    this.zoneProgression = c.createDiv({ cls: 'vinyle-progression' });
    this.jauge = this.zoneProgression.createDiv({ cls: 'vinyle-jauge' });
    this.jauge.createDiv({ cls: 'vinyle-jauge-remplie' });
    this.temps = this.zoneProgression.createDiv({ cls: 'vinyle-temps' });

    // L'étagère et le tiroir de la galerie voyagent ensemble : le calcul de
    // taille n'a ainsi qu'un seul bloc à retrancher, en hauteur comme en
    // largeur, et le passage en colonne les emporte tous les deux.
    this.bac = c.createDiv({ cls: 'vinyle-bac' });
    this.etagere = this.bac.createDiv({ cls: 'vinyle-etagere' });
    this.rail = this.etagere.createDiv({ cls: 'vinyle-rail' });
    this.tiroir = this.bac.createDiv({ cls: 'vinyle-tiroir' });
    this.galerie = this.tiroir.createDiv({ cls: 'vinyle-galerie' });
    // Le disque qui vole de la galerie au plateau. Hors du flux, il ne doit
    // jamais peser sur la mise en page.
    this.vol = c.createDiv({ cls: 'vinyle-vol' });
    this.volImage = this.vol.createDiv({ cls: 'vinyle-vol-image' });
    this.vol.createDiv({ cls: 'vinyle-vol-trou' });
    this.itemOuvert = null;
    this.tiroirOuvert = false;
    this.hauteurTiroir = 0;
    this.charge = null;
    this.poseAttendue = 0;

    this.ecouter(this.bras, 'mousedown', (e) => this.saisirBras(e));
    // Un seul écouteur pour toute la galerie : une liste de 933 titres en
    // poserait autant, et ils survivraient à chaque regarnissage.
    this.ecouter(this.galerie, 'click', (e) => this.clicGalerie(e));
    this.ecouter(this.galerie, 'dragstart', (e) => {
      const c = e.target && e.target.closest ? e.target.closest('.vinyle-galette') : null;
      if (!c || !c.__piste || !this.itemOuvert) return;
      this.charge = { genre: 'piste', item: this.itemOuvert, piste: c.__piste, caisse: c };
      c.addClass('vinyle-enleve');
      this.plateau.addClass('vinyle-recoit');
      if (e.dataTransfer) {
        e.dataTransfer.setData('text/plain', 'vinyle:piste');
        e.dataTransfer.effectAllowed = 'copy';
      }
    });
    this.ecouter(this.galerie, 'dragend', () => this.nettoyerGlissement());

    // Le disque en cours se retire du plateau pour être rangé dans le bac.
    // La saisie du bras arrête la propagation et empêche son propre mousedown
    // de déclencher un glissement : les deux gestes ne se marchent pas dessus.
    this.porteur.setAttribute('draggable', 'true');
    this.ecouter(this.porteur, 'dragstart', (e) => {
      const p = this.greffon.piste;
      // Rien ne joue, ou pas de bac où ranger : le geste n'a pas de sens.
      if (!p || !p.titre || !this.bac || this.bac.offsetParent === null) {
        e.preventDefault();
        return;
      }
      this.charge = { genre: 'plateau' };
      this.bac.addClass('vinyle-recoit');
      if (e.dataTransfer) {
        e.dataTransfer.setData('text/plain', 'vinyle:plateau');
        e.dataTransfer.effectAllowed = 'move';
      }
    });
    this.ecouter(this.porteur, 'dragend', () => this.nettoyerGlissement());
    this.ecouter(this.galerie, 'keydown', (e) => {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      e.preventDefault();
      this.clicGalerie(e);
    });
    this.installerDepot();
    this.rendreEtagere();

    this.appliquerOptions();
    this.peindre(this.greffon.piste, this.greffon.urlPochette);

    // Le conteneur est redimensionnable et son contenu change de hauteur avec
    // le titre : un observateur vaut mieux qu'un écouteur de fenêtre, qui
    // manquerait le glissement d'une cloison ou l'étirement du panneau.
    const vue = c.ownerDocument.defaultView || window;
    if (typeof vue.ResizeObserver === 'function') {
      this.observateur = new vue.ResizeObserver(() => this.ajusterTaille());
      this.observateur.observe(c);
      this.observateur.observe(this.infos);
    }
    // La mise en page n'est pas faite à cet instant : les hauteurs valent zéro.
    vue.requestAnimationFrame(() => this.ajusterTaille());
    return this;
  }

  demonter() {
    if (this.minuteurEchange) window.clearTimeout(this.minuteurEchange);
    if (this.minuteurFin) window.clearTimeout(this.minuteurFin);
    if (this.minuteurGalerie) window.clearTimeout(this.minuteurGalerie);
    if (this.minuteurVol) window.clearTimeout(this.minuteurVol);
    if (this.guetteur) { this.guetteur.disconnect(); this.guetteur = null; }
    if (this.observateur) { this.observateur.disconnect(); this.observateur = null; }
    for (const [cible, type, fn] of this.evenements) cible.removeEventListener(type, fn);
    this.evenements = [];
  }

  bouton(parent, icone, infobulle, ordre) {
    const b = parent.createEl('button', { cls: 'vinyle-bouton' });
    obsidian.setIcon(b, icone);
    b.setAttribute('aria-label', infobulle);
    this.ecouter(b, 'click', async () => {
      b.addClass('vinyle-occupe');
      await commander(ordre);
      b.removeClass('vinyle-occupe');
      this.greffon.battre(true);
    });
    return b;
  }

  appliquerOptions() {
    if (!this.bras) return;
    if (this.bac) {
      const cache = this.greffon.reglages.montrerEtagere === false;
      this.bac.toggleClass('vinyle-invisible', cache);
      if (cache) this.fermerGalerie();
    }
    this.bras.toggleClass('vinyle-invisible', !this.greffon.reglages.montrerBras);
    this.zoneProgression.toggleClass('vinyle-invisible', !this.greffon.reglages.montrerProgression);
    this.tailleAppliquee = null; // forcer un recalcul après changement d'option
    this.ajusterTaille();
  }

  // Le disque prend la place disponible, sans jamais rejeter les textes ni les
  // commandes hors du cadre. On mesure la hauteur réellement occupée par le
  // reste plutôt que de la deviner : elle change avec un titre sur deux lignes,
  // avec la progression masquée, et avec la taille de police du thème.
  ajusterTaille() {
    const r = this.greffon.reglages;
    const el = this.el;
    if (!el || !this.plateau) return;

    // La marge latérale vaut dans les deux modes : les textes la portent, que le
    // disque soit dimensionné automatiquement ou non.
    const margeLat = Math.round(Math.min(36, Math.max(16, el.clientWidth * 0.08)));
    if (this.margeLat !== margeLat) {
      this.margeLat = margeLat;
      el.style.setProperty('--vinyle-marge-lat', margeLat + 'px');
    }

    let t;
    if (!r.tailleAuto) {
      t = r.tailleDisque || 300;
    } else {
      const vue = el.ownerDocument.defaultView || window;
      const style = vue.getComputedStyle(el);
      const marges = parseFloat(style.paddingTop) + parseFloat(style.paddingBottom);
      // Le disque reçoit la marge par le calcul, et non par un padding du cadre,
      // pour que le bac puisse venir au ras des bords.
      const cotes = margeLat * 2;
      const ecart = parseFloat(style.rowGap) || 0;

      // Cadre plus large que haut : l'étagère se range à droite du plateau,
      // sinon elle passe dessous. On ne bascule la classe que si elle change,
      // sans quoi la bascule relancerait l'observateur.
      const large = el.clientWidth > el.clientHeight * 1.15;
      if (this.enLarge !== large) { this.enLarge = large; el.toggleClass('vinyle-large', large); }

      const visible = (x) => x && x.offsetParent !== null;
      let occupe = marges;
      for (const enfant of [this.commandes, this.infos, this.zoneProgression]) {
        if (visible(enfant)) occupe += enfant.offsetHeight + ecart;
      }
      let largeurPrise = cotes;
      let ecartBac = 0;
      if (visible(this.bac)) {
        if (large) {
          largeurPrise += this.bac.offsetWidth + ecart;
        } else {
          // On mesure l'étagère seule et on ajoutera la hauteur voulue du
          // tiroir : pendant qu'il s'ouvre, sa hauteur réelle change à chaque
          // image et l'observateur lutterait contre sa propre transition.
          ecartBac = parseFloat(vue.getComputedStyle(this.bac).rowGap) || 0;
          occupe += this.etagere.offsetHeight + ecart;
        }
      }

      // Le disque garde environ les deux tiers de ce qu'il occuperait sans
      // galerie, et la galerie prend le reste. On procède dans cet ordre pour
      // que le calcul ne tourne pas en rond : la place disponible est connue
      // avant que le tiroir n'en réclame sa part.
      let hTiroir = 0;
      // Étagère masquée par les réglages : le tiroir ne prend plus de place,
      // sans quoi le disque garderait un trou sous lui.
      if (this.tiroirOuvert && visible(this.bac)) {
        if (large) {
          // En colonne, le tiroir partage la hauteur avec l'étagère et ne
          // touche pas au disque, qui n'est borné que par la largeur.
          hTiroir = Math.round(Math.max(110, el.clientHeight * 0.55));
        } else {
          const dispo = el.clientHeight - occupe;
          // Le disque ne dépassera de toute façon ni son plafond réglé ni la
          // largeur disponible. Sans en tenir compte, le tiroir s'arrêtait à sa
          // part des deux tiers et laissait du vide sous lui dans une grande
          // fenêtre : la galerie paraissait coupée sans raison.
          const voulu = Math.min(r.tailleMax || 460,
            Math.round(dispo * 0.63),
            el.clientWidth - largeurPrise);
          // Le plancher de 110 pixels garantit une rangée de disques entière,
          // quitte à rogner le plateau dans un panneau vraiment étroit.
          hTiroir = Math.round(Math.max(110, dispo - Math.max(110, voulu) - ecartBac));
          occupe += hTiroir + ecartBac;
        }
        if (this.hauteurTiroir !== hTiroir) {
          this.hauteurTiroir = hTiroir;
          this.tiroir.style.setProperty('--vinyle-tiroir', hTiroir + 'px');
        }
      }
      t = Math.min(r.tailleMax || 460, el.clientWidth - largeurPrise, el.clientHeight - occupe);
    }

    t = Math.round(Math.max(120, Math.min(900, t)));
    // Sans ce seuil, poser la variable relancerait l'observateur en boucle.
    if (this.tailleAppliquee != null && Math.abs(this.tailleAppliquee - t) < 2) return;
    this.tailleAppliquee = t;
    el.style.setProperty('--vinyle-taille', t + 'px');
  }

  /* ----------------------------- L'étagère ----------------------------- */

  rendreEtagere() {
    if (!this.rail) return;
    const g = this.greffon;
    const liste = g.reglages.etagere || [];
    this.etagere.toggleClass('vinyle-invisible', g.reglages.montrerEtagere === false);
    this.rail.empty();

    for (const item of liste) {
      const d = this.rail.createDiv({ cls: 'vinyle-pochette-etagere' });
      d.setAttribute('draggable', 'true');
      d.__cle = cleItem(item);
      d.setAttribute('aria-label', (item.type === 'liste' ? 'Liste' : 'Album') + ' : ' + item.nom);
      const rond = d.createDiv({ cls: 'vinyle-jaquette' });
      d.createDiv({ cls: 'vinyle-etiquette-etagere', text: item.nom });
      if (this.itemOuvert && cleItem(this.itemOuvert) === cleItem(item)) d.addClass('vinyle-choisi');

      // La pochette peut n'être pas encore extraite : on pose le disque tout de
      // suite et on l'habille dès qu'elle arrive, plutôt que de bloquer.
      g.pochetteEtagere(item).then((url) => {
        if (url && rond.isConnected) rond.style.backgroundImage = 'url("' + url + '")';
      });

      this.ecouter(d, 'dragstart', (e) => {
        this.charge = { genre: 'disque', item };
        d.addClass('vinyle-enleve');
        this.plateau.addClass('vinyle-recoit');
        if (e.dataTransfer) {
          e.dataTransfer.setData('text/plain', 'vinyle:' + cleItem(item));
          e.dataTransfer.effectAllowed = 'copy';
        }
      });
      this.ecouter(d, 'dragend', () => this.nettoyerGlissement());
      // Le clic ouvre la galerie du disque ; poser la liste entière reste
      // accessible par le glissement sur le plateau et par le menu contextuel.
      this.ecouter(d, 'click', () => this.ouvrirGalerie(item));
      this.ecouter(d, 'contextmenu', (e) => {
        e.preventDefault();
        const menu = new obsidian.Menu();
        menu.addItem((m) => m.setTitle('Poser sur la platine').setIcon('play')
          .onClick(() => g.poserDisque(item)));
        menu.addItem((m) => m.setTitle("Retirer de l'étagère").setIcon('trash-2')
          .onClick(() => g.retirerEtagere(item)));
        menu.showAtMouseEvent(e);
      });
    }

    const plus = this.rail.createDiv({ cls: 'vinyle-pochette-etagere vinyle-ajouter' });
    plus.setAttribute('aria-label', "Ajouter un disque à l'étagère");
    const rondPlus = plus.createDiv({ cls: 'vinyle-jaquette' });
    obsidian.setIcon(rondPlus, 'plus');
    this.ecouter(plus, 'click', () => new SelecteurDisque(this.greffon.app, this.greffon).open());
    if (!liste.length) this.rail.createDiv({ cls: 'vinyle-etagere-vide', text: 'Étagère vide' });

    // Le disque ouvert a pu être retiré de l'étagère entre-temps.
    if (this.itemOuvert && !liste.some((x) => cleItem(x) === cleItem(this.itemOuvert))) {
      this.fermerGalerie();
    }

    this.tailleAppliquee = null;
    this.ajusterTaille();
  }

  /* ---------------------------- La galerie ----------------------------- */

  // Le disque déjà ouvert se referme : la même jaquette sert d'aller et de
  // retour, ce qui évite un bouton de plus dans un panneau étroit.
  ouvrirGalerie(item) {
    if (!this.tiroir) return;
    const cle = cleItem(item);
    if (this.itemOuvert && cleItem(this.itemOuvert) === cle) { this.fermerGalerie(); return; }

    const premier = !this.itemOuvert;
    this.itemOuvert = item;
    // Les pochettes du disque qu'on quitte ne servent plus à rien.
    this.greffon.viderAttente();
    this.marquerChoisi();

    if (premier) {
      this.tiroirOuvert = true;
      this.tiroir.addClass('vinyle-ouvert');
      this.bac.addClass('vinyle-deploye');
      // Le titre et l'artiste de la piste en cours font double emploi avec la
      // galerie, qui les affiche pour chaque morceau. On les efface le temps
      // qu'elle est ouverte : elle y gagne une soixantaine de pixels, ce qui
      // fait la différence entre une rangée et deux dans un panneau étroit.
      this.el.addClass('vinyle-galerie-ouverte');
      // Le plateau ne rétrécit pas de lui-même : c'est le calcul de taille qui
      // lui retranche la hauteur du tiroir, et la feuille de style l'y amène.
      this.tailleAppliquee = null;
      this.ajusterTaille();
    } else {
      // Tiroir déjà ouvert : l'ancienne galerie s'en va vers la gauche et la
      // nouvelle entre par la droite, comme les disques s'échangent.
      this.galerie.addClass('vinyle-part');
    }

    if (this.minuteurGalerie) window.clearTimeout(this.minuteurGalerie);
    this.minuteurGalerie = window.setTimeout(() => this.garnirGalerie(item), premier ? 180 : 170);
  }

  fermerGalerie() {
    if (!this.itemOuvert || !this.tiroir) return;
    this.itemOuvert = null;
    this.greffon.viderAttente();
    if (this.guetteur) { this.guetteur.disconnect(); this.guetteur = null; }
    this.marquerChoisi();

    // On se retire toujours plus vite qu'on n'est entré : dix millisecondes
    // d'écart au lieu de quarante-six, et en commençant par la fin.
    const cases = Array.from(this.galerie.children);
    const n = cases.length;
    cases.forEach((c, i) => {
      c.style.animation = 'none';
      c.style.transition = 'opacity 140ms ease ' + ((n - i) * 10) + 'ms';
      c.style.opacity = '0';
    });

    if (this.minuteurGalerie) window.clearTimeout(this.minuteurGalerie);
    this.minuteurGalerie = window.setTimeout(() => {
      this.tiroirOuvert = false;
      this.tiroir.removeClass('vinyle-ouvert');
      this.bac.removeClass('vinyle-deploye');
      this.el.removeClass('vinyle-galerie-ouverte');
      this.galerie.empty();
      this.tailleAppliquee = null;
      this.ajusterTaille();
    }, Math.min(200, 110 + n * 10));
  }

  marquerChoisi() {
    if (!this.rail) return;
    const ouvert = this.itemOuvert ? cleItem(this.itemOuvert) : null;
    for (const d of Array.from(this.rail.children)) {
      d.toggleClass('vinyle-choisi', !!ouvert && d.__cle === ouvert);
    }
  }

  async garnirGalerie(item) {
    const g = this.greffon;
    const vue = this.el.ownerDocument.defaultView || window;
    const r = await g.pistesDe(item);
    // L'interrogation dure deux cents millisecondes : le disque ouvert a pu
    // changer entre-temps, auquel cas ce garnissage n'a plus lieu d'être.
    if (!this.itemOuvert || cleItem(this.itemOuvert) !== cleItem(item)) return;

    if (this.guetteur) { this.guetteur.disconnect(); this.guetteur = null; }
    this.galerie.empty();
    this.galerie.removeClass('vinyle-part');

    if (r.erreur || !r.pistes || !r.pistes.length) {
      this.galerie.createDiv({ cls: 'vinyle-galerie-vide',
        text: r.erreur ? 'Disque illisible' : 'Aucun morceau' });
      return;
    }

    // Les pochettes ne sont demandées qu'à l'approche du champ de vision, une
    // à la fois. Sur 351 titres, les tirer toutes ferait plus d'une minute.
    if (typeof vue.IntersectionObserver === 'function') {
      this.guetteur = new vue.IntersectionObserver((entrees) => {
        for (const e of entrees) {
          if (!e.isIntersecting) continue;
          this.guetteur.unobserve(e.target);
          const caisse = e.target;
          const image = caisse.querySelector('.vinyle-galette-image');
          g.enfiler(() => g.pochettePiste(item, caisse.__piste)).then((url) => {
            if (!url || !image || !image.isConnected) return;
            image.style.backgroundImage = 'url("' + url + '")';
            image.addClass('vinyle-habille');
          });
        }
      }, { root: this.galerie, rootMargin: '120px' });
    }

    r.pistes.forEach((piste, i) => {
      const c = this.galerie.createDiv({ cls: 'vinyle-galette' });
      c.__piste = piste;
      c.setAttribute('role', 'button');
      c.setAttribute('tabindex', '0');
      c.setAttribute('draggable', 'true');
      c.setAttribute('aria-label', piste.titre + (piste.artiste ? ' — ' + piste.artiste : ''));
      const d = c.createDiv({ cls: 'vinyle-galette-disque' });
      d.createDiv({ cls: 'vinyle-galette-image' });
      d.createDiv({ cls: 'vinyle-galette-trou' });
      const t = c.createDiv({ cls: 'vinyle-galette-texte' });
      t.createDiv({ cls: 'vinyle-galette-titre', text: piste.titre });
      t.createDiv({ cls: 'vinyle-galette-artiste', text: piste.artiste });

      // La case porte la chute, le disque porte l'écrasement : une seule
      // transformation par élément, sinon l'une écrase l'autre.
      const retard = Math.min(i, 12) * 46;
      c.style.animationDelay = retard + 'ms';
      d.style.animationDelay = retard + 'ms';
    });

    vue.requestAnimationFrame(() => {
      for (const c of Array.from(this.galerie.children)) {
        c.addClass('vinyle-tombe');
        if (this.guetteur) this.guetteur.observe(c);
      }
    });

    // Les cases sont neuves : l'ancienne référence pointait sur un nœud détruit.
    this.pidSurPlatine = undefined;
    this.caseSurPlatine = null;
    this.marquerSurPlatine(this.greffon.piste);
  }

  // Le disque posé sur la platine n'est plus dans le bac : sa case reste, vide.
  // On se règle sur ce que Music joue réellement, et non sur ce qui a été
  // cliqué : le trou suit alors la musique quand elle change toute seule, et se
  // rebouche dès qu'on range le disque, sans aucun cas particulier à prévoir.
  marquerSurPlatine(piste) {
    if (!this.galerie) return;
    const pid = (piste && piste.id) || null;
    if (this.pidSurPlatine === pid) return;   // rien n'a changé, rien à parcourir
    this.pidSurPlatine = pid;
    if (this.caseSurPlatine) {
      this.caseSurPlatine.removeClass('vinyle-sur-platine');
      this.caseSurPlatine = null;
    }
    if (!pid) return;
    for (const c of Array.from(this.galerie.children)) {
      if (c.__piste && c.__piste.pid === pid) {
        c.addClass('vinyle-sur-platine');
        this.caseSurPlatine = c;
        break;
      }
    }
  }

  clicGalerie(e) {
    const c = e.target && e.target.closest ? e.target.closest('.vinyle-galette') : null;
    if (!c || !c.__piste || !this.itemOuvert) return;
    this.choisirPiste(this.itemOuvert, c.__piste, c);
  }

  async choisirPiste(item, piste, caisse) {
    if (this.volEnCours) return;
    // Le vol emporte le disque : sa case doit se vider tout de suite, sans
    // attendre le battement suivant, sinon on verrait deux fois le même disque.
    this.viderCase(caisse, piste);
    this.volerVersPlateau(caisse);
    const ok = await this.greffon.poserPiste(item, piste);
    if (!ok) this.marquerSurPlatine(this.greffon.piste);
  }

  viderCase(caisse, piste) {
    if (this.caseSurPlatine) this.caseSurPlatine.removeClass('vinyle-sur-platine');
    caisse.addClass('vinyle-sur-platine');
    this.caseSurPlatine = caisse;
    this.pidSurPlatine = piste.pid || null;
  }

  // Un disque vole d'un point à l'autre du cadre, dans un élément posé hors du
  // flux : animer l'original déplacerait la galerie sous le doigt. Le même vol
  // sert à poser un morceau sur le plateau et à en ranger un dans le bac.
  voler(depart, arrivee, image) {
    const vue = this.el.ownerDocument.defaultView || window;
    if (vue.matchMedia && vue.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    if (!this.vol || !depart.width || !arrivee.width) return;

    const cadre = this.el.getBoundingClientRect();
    this.volImage.style.backgroundImage = image || '';
    this.vol.style.width = depart.width + 'px';
    this.vol.style.height = depart.height + 'px';
    this.vol.style.left = (depart.left - cadre.left) + 'px';
    this.vol.style.top = (depart.top - cadre.top) + 'px';
    this.vol.style.transition = 'none';
    this.vol.style.transform = 'translate(0, 0) scale(1)';
    this.vol.offsetHeight;  // forcer le reflux, sans quoi le départ est ignoré
    this.vol.style.transition = '';
    this.vol.addClass('vinyle-vole');

    const dx = (arrivee.left + arrivee.width / 2) - (depart.left + depart.width / 2);
    const dy = (arrivee.top + arrivee.height / 2) - (depart.top + depart.height / 2);
    this.vol.style.transform =
      'translate(' + Math.round(dx) + 'px, ' + Math.round(dy) + 'px) scale('
      + (arrivee.width / depart.width).toFixed(3) + ')';

    this.volEnCours = true;
    if (this.minuteurVol) window.clearTimeout(this.minuteurVol);
    this.minuteurVol = window.setTimeout(() => {
      this.vol.removeClass('vinyle-vole');
      this.volEnCours = false;
    }, 460);
  }

  volerVersPlateau(caisse) {
    const source = caisse.querySelector('.vinyle-galette-disque');
    if (!source) return;
    const image = caisse.querySelector('.vinyle-galette-image');
    this.voler(source.getBoundingClientRect(), this.plateau.getBoundingClientRect(),
      image ? image.style.backgroundImage : '');
  }

  installerDepot() {
    // Le plateau reçoit un disque entier ou un seul morceau.
    this.ecouter(this.plateau, 'dragover', (e) => {
      if (!this.charge || this.charge.genre === 'plateau') return;
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
      this.plateau.addClass('vinyle-survol');
    });
    this.ecouter(this.plateau, 'dragleave', () => this.plateau.removeClass('vinyle-survol'));
    this.ecouter(this.plateau, 'drop', (e) => {
      const c = this.charge;
      this.nettoyerGlissement();
      if (!c || c.genre === 'plateau') return;
      e.preventDefault();
      e.stopPropagation();
      // Ni vol, ni échange : c'est la main qui a fait le trajet. Le disque se
      // pose là où on l'a lâché, au lieu d'entrer par le côté comme lors d'un
      // changement automatique. Le drapeau se périme, faute de quoi un
      // changement de piste survenu bien plus tard en hériterait.
      this.poseAttendue = Date.now() + 4000;
      if (c.genre === 'piste') {
        if (c.caisse) this.viderCase(c.caisse, c.piste);
        this.greffon.poserPiste(c.item, c.piste);
      }
      else this.greffon.poserDisque(c.item);
    });

    // Le bac range le disque du plateau, ce qui arrête la lecture.
    this.ecouter(this.bac, 'dragover', (e) => {
      if (!this.charge || this.charge.genre !== 'plateau') return;
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
      this.bac.addClass('vinyle-survol');
    });
    this.ecouter(this.bac, 'dragleave', () => this.bac.removeClass('vinyle-survol'));
    this.ecouter(this.bac, 'drop', (e) => {
      const c = this.charge;
      this.nettoyerGlissement();
      if (!c || c.genre !== 'plateau') return;
      e.preventDefault();
      e.stopPropagation();
      this.rangerDisque();
    });
  }

  nettoyerGlissement() {
    this.charge = null;
    if (this.plateau) {
      this.plateau.removeClass('vinyle-recoit');
      this.plateau.removeClass('vinyle-survol');
    }
    if (this.bac) {
      this.bac.removeClass('vinyle-recoit');
      this.bac.removeClass('vinyle-survol');
    }
    for (const d of Array.from(this.rail ? this.rail.children : [])) d.removeClass('vinyle-enleve');
    for (const c of Array.from(this.galerie ? this.galerie.children : [])) c.removeClass('vinyle-enleve');
  }

  // Ranger arrête pour de bon, là où le bras relevé ne fait que suspendre :
  // deux gestes, deux sens, comme sur un vrai tourne-disque.
  async rangerDisque() {
    const cible = this.cibleDeRangement();
    if (cible) {
      this.glisserDansPochette(this.plateau.getBoundingClientRect(), cible,
        this.pochette ? this.pochette.style.backgroundImage : '');
    }
    await commander('arret');
    this.greffon.battre(true);
  }

  // Un disque entre dans sa pochette par le haut, et ce qui est entré est caché
  // par la pochette, non fondu. D'où deux temps : il vient d'abord se placer
  // au-dessus de la jaquette, puis il y descend en passant derrière elle. La
  // jaquette étant opaque, elle le mange à mesure, ce qu'aucune opacité ne
  // saurait imiter.
  glisserDansPochette(depart, cible, image) {
    const vue = this.el.ownerDocument.defaultView || window;
    if (vue.matchMedia && vue.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    if (!this.vol || !depart.width) return;
    const jaquette = cible.querySelector ? (cible.querySelector('.vinyle-jaquette') || cible) : cible;
    const r = jaquette.getBoundingClientRect();
    if (!r.width) return;

    const cadre = this.el.getBoundingClientRect();
    const milieuX = (a) => a.left + a.width / 2;
    const milieuY = (a) => a.top + a.height / 2;
    const k = r.width / depart.width;
    const dx = Math.round(milieuX(r) - milieuX(depart));
    // Le disque s'arrête presque collé au-dessus de la pochette, comme une main
    // qui le présente à l'ouverture avant de l'y glisser.
    const dyHaut = Math.round((milieuY(r) - r.height * 0.92) - milieuY(depart));
    const dyBas = Math.round(milieuY(r) - milieuY(depart));
    const echelle = k.toFixed(3);

    this.volImage.style.backgroundImage = image || '';
    this.vol.style.width = depart.width + 'px';
    this.vol.style.height = depart.height + 'px';
    this.vol.style.left = (depart.left - cadre.left) + 'px';
    this.vol.style.top = (depart.top - cadre.top) + 'px';
    this.vol.removeClass('vinyle-range');
    this.vol.style.transition = 'none';
    this.vol.style.transform = 'translate(0, 0) scale(1)';
    this.vol.offsetHeight;  // forcer le reflux, sans quoi le départ est ignoré
    this.vol.style.transition = '';
    this.vol.addClass('vinyle-vole');
    this.vol.style.transform = 'translate(' + dx + 'px, ' + dyHaut + 'px) scale(' + echelle + ')';

    this.volEnCours = true;
    if (this.minuteurVol) window.clearTimeout(this.minuteurVol);
    this.minuteurVol = window.setTimeout(() => {
      // La classe fait deux choses : elle raccourcit la course et fait passer le
      // disque sous le bac, donc sous la jaquette.
      this.vol.addClass('vinyle-range');
      this.vol.style.transform = 'translate(' + dx + 'px, ' + dyBas + 'px) scale(' + echelle + ')';
      this.minuteurVol = window.setTimeout(() => {
        // L'ordre compte, et il n'est pas celui qu'on croit. Éteindre en fondu
        // tout en rendant au disque son plan habituel le fait reparaître devant
        // la pochette le temps du fondu. On coupe donc la transition, on éteint
        // d'un coup pendant qu'il est encore derrière, et on ne le remonte
        // qu'ensuite.
        this.vol.style.transition = 'none';
        this.vol.removeClass('vinyle-vole');
        void this.vol.offsetWidth;
        this.vol.removeClass('vinyle-range');
        this.vol.style.transition = '';
        this.volEnCours = false;
      }, 320);
    }, 420);
  }

  // Le disque rentre chez lui quand on sait où : la jaquette du disque ouvert,
  // sinon la première de l'étagère, sinon le bac lui-même.
  cibleDeRangement() {
    if (!this.rail) return this.bac;
    const cases = Array.from(this.rail.children).filter((d) => d.__cle);
    const ouvert = this.itemOuvert ? cleItem(this.itemOuvert) : null;
    if (ouvert) {
      const t = cases.find((d) => d.__cle === ouvert);
      if (t) return t;
    }
    return cases[0] || this.bac;
  }

  /* --------------------------- Changer de disque ------------------------ */

  poserPochette(url) {
    if (url) {
      this.pochette.style.backgroundImage = 'url("' + url + '")';
      this.pochette.removeClass('vinyle-sans-pochette');
    } else {
      this.pochette.style.backgroundImage = '';
      this.pochette.addClass('vinyle-sans-pochette');
    }
  }

  // Le disque sortant glisse vers la gauche, le suivant entre par la droite,
  // côté étagère. La pochette est remplacée au creux du mouvement, quand rien
  // n'est visible, ce qui évite tout clignotement.
  echangerDisque(url) {
    if (this.minuteurEchange) window.clearTimeout(this.minuteurEchange);
    if (this.minuteurFin) window.clearTimeout(this.minuteurFin);
    this.porteur.removeClass('vinyle-echange');
    // Forcer un reflux, sans quoi rejouer la même animation ne repart pas.
    void this.porteur.offsetWidth;
    this.porteur.addClass('vinyle-echange');
    // 420 ms au total, la pochette changeant à mi-course. Au-delà, l'attente se
    // sent : on regarde un disque vide pendant que la musique a déjà changé.
    this.minuteurEchange = window.setTimeout(() => this.poserPochette(url), 190);
    this.minuteurFin = window.setTimeout(() => this.porteur.removeClass('vinyle-echange'), 440);
  }

  // Le disque qu'on vient de lâcher se cale sur le plateau : il arrive un peu
  // plus grand, s'enfonce, puis reprend sa taille. Rien n'entre par le côté,
  // sans quoi le geste ressemblerait à un changement automatique.
  poserSurPlateau(url) {
    if (this.minuteurEchange) window.clearTimeout(this.minuteurEchange);
    if (this.minuteurFin) window.clearTimeout(this.minuteurFin);
    this.porteur.removeClass('vinyle-echange');
    this.porteur.removeClass('vinyle-pose');
    this.plateau.removeClass('vinyle-pose');
    // Forcer un reflux, sans quoi rejouer la même animation ne repart pas.
    void this.porteur.offsetWidth;
    // La pochette est posée d'emblée : le disque arrive déjà habillé, il n'y a
    // pas de creux où la cacher comme dans l'échange.
    this.poserPochette(url);
    this.porteur.addClass('vinyle-pose');
    this.plateau.addClass('vinyle-pose');
    this.minuteurFin = window.setTimeout(() => {
      this.porteur.removeClass('vinyle-pose');
      this.plateau.removeClass('vinyle-pose');
    }, 360);
  }

  /* ------------------------------ Le bras ------------------------------ */

  poserBras(angle) {
    if (this.bras) this.bras.style.transform = 'rotate(' + angle.toFixed(2) + 'deg)';
  }

  // Angle du bras correspondant à la position du pointeur. Le pivot se déduit
  // du plateau, seul élément dont la boîte n'est pas déformée par la rotation.
  angleDepuisPointeur(e) {
    const r = this.plateau.getBoundingClientRect();
    const cote = r.width;
    const vx = e.clientX - (r.left + BRAS_PIVOT_X * cote);
    const vy = e.clientY - (r.top + BRAS_PIVOT_Y * cote);
    if (vy <= 0) return BRAS_LEVE; // pointeur au-dessus du pivot : bras relevé
    return Math.atan2(-vx, vy) * 180 / Math.PI;
  }

  saisirBras(e) {
    const piste = this.greffon.piste;
    if (!piste || !piste.titre) return; // rien à parcourir
    e.preventDefault();
    e.stopPropagation();

    const doc = this.el.ownerDocument;
    this.saisi = true;
    this.angleSaisi = this.angleDepuisPointeur(e);
    this.bras.addClass('vinyle-bras-saisi');
    this.plateau.addClass('vinyle-parcours');

    // Le frottement s'ouvre avec le geste : c'est ce clic qui autorise le
    // contexte audio, le navigateur refusant d'en ouvrir un sans geste humain.
    this.greffon.bruiteur.ouvrirFrottement();
    this.dernierTemps = 0;

    const bouger = (ev) => {
      const angle = Math.max(BRAS_LEVE, Math.min(BRAS_FIN, this.angleDepuisPointeur(ev)));
      // La vitesse du geste, et non celle du morceau : plus la main va vite,
      // plus le sillon crisse haut.
      const t = Date.now();
      if (this.dernierTemps) {
        const dt = Math.max(16, t - this.dernierTemps);
        this.greffon.bruiteur.reglerFrottement(Math.abs(angle - this.angleSaisi) / dt * 22);
      }
      this.dernierTemps = t;
      this.angleSaisi = angle;
      this.poserBras(this.angleSaisi);
      this.montrerApercu(this.angleSaisi);
    };
    const lacher = async () => {
      doc.removeEventListener('mousemove', bouger);
      doc.removeEventListener('mouseup', lacher);
      this.bras.removeClass('vinyle-bras-saisi');
      this.plateau.removeClass('vinyle-parcours');
      this.saisi = false;
      this.greffon.bruiteur.fermerFrottement();
      // Lâché hors du disque, le bras regagne son lit ; lâché dessus, le saphir
      // se pose. Le bruit précède la commande, qui met le temps d'un
      // aller-retour avec Music.
      if (this.angleSaisi < BRAS_SEUIL_POSE) this.greffon.bruiteur.reposerBras();
      else this.greffon.bruiteur.poserSaphir();
      await this.appliquerBras(this.angleSaisi);
    };
    doc.addEventListener('mousemove', bouger);
    doc.addEventListener('mouseup', lacher);
    bouger(e);
  }

  // Pendant le geste, on montre où l'on tomberait sans rien commander encore.
  montrerApercu(angle) {
    const piste = this.greffon.piste;
    const total = (piste && piste.duree) || 0;
    if (angle < BRAS_SEUIL_POSE) {
      this.temps.setText('Relâcher pour mettre en pause');
      return;
    }
    const cible = progressionDeAngle(angle) * total;
    const remplie = this.jauge.firstElementChild;
    if (remplie) remplie.style.width = (total > 0 ? (cible / total) * 100 : 0).toFixed(2) + '%';
    this.temps.setText(duree(cible) + ' / ' + duree(total));
  }

  async appliquerBras(angle) {
    const piste = this.greffon.piste;
    if (!piste || !piste.titre) return;

    if (angle < BRAS_SEUIL_POSE) {
      // Bras relevé hors du disque : on arrête, comme on lèverait le saphir.
      await commander('pause');
      await this.greffon.battre(true);
      return;
    }
    const total = piste.duree || 0;
    if (total > 0) await positionner(progressionDeAngle(angle) * total);
    // Reposer le bras sur un disque à l'arrêt relance la lecture : c'est le
    // geste inverse de celui qui l'a mis en pause.
    if (piste.etat !== 'lecture') await commander('jouer');
    await this.greffon.battre(true);
  }

  peindre(piste, urlPochette) {
    if (!this.plateau) return;
    const joue = !!(piste && piste.etat === 'lecture');
    const enPiste = !!(piste && piste.titre);

    this.disque.toggleClass('vinyle-tourne', joue);
    this.plateau.toggleClass('vinyle-actif', enPiste);

    // Changement de piste : le disque s'échange tout seul. Au premier rendu
    // il n'y a rien à remplacer, on pose directement.
    const id = (piste && piste.id) || null;
    if (this.idAffiche !== undefined && id && id !== this.idAffiche) {
      if (this.poseAttendue && Date.now() < this.poseAttendue) this.poserSurPlateau(urlPochette);
      else this.echangerDisque(urlPochette);
      this.poseAttendue = 0;
    } else {
      this.poserPochette(urlPochette);
    }
    this.idAffiche = id;
    this.marquerSurPlatine(enPiste ? piste : null);

    obsidian.setIcon(this.btnJouer, joue ? 'pause' : 'play');

    this.elTitre.setText(enPiste ? piste.titre : 'Rien ne joue');
    this.elArtiste.setText(enPiste ? (piste.artiste || '') : '');
    this.elAlbum.setText(enPiste ? (piste.album || '') : '');

    const total = enPiste ? (piste.duree || 0) : 0;
    const pos = enPiste ? Math.min(piste.position || 0, total) : 0;
    const part = total > 0 ? (pos / total) * 100 : 0;
    // Pendant le geste, la main commande : ni le bras ni la jauge ne sont
    // repeints, sans quoi le bras sauterait sous le doigt à chaque battement.
    if (!this.saisi) {
      const remplie = this.jauge.firstElementChild;
      if (remplie) remplie.style.width = part.toFixed(2) + '%';
      this.temps.setText(enPiste ? duree(pos) + ' / ' + duree(total) : '');
      // Le bras avance vers le centre au fil du morceau, et se relève à l'arrêt.
      this.poserBras(joue ? angleDeProgression(total > 0 ? pos / total : 0) : BRAS_LEVE);
    }
    this.ajusterTaille();
  }
}

/* =========================================================================
 * Le volet
 * ========================================================================= */

class VueVinyle extends obsidian.ItemView {
  constructor(feuille, greffon) {
    super(feuille);
    this.greffon = greffon;
  }

  getViewType() { return TYPE_VUE; }
  getDisplayText() { return 'Vinyle'; }
  getIcon() { return 'disc-3'; }

  async onOpen() {
    this.platine = new Platine(this.greffon, this.contentEl).monter();
    // Le volet vient de s'ouvrir : on relance le sondage, qui dormait peut-être.
    this.greffon.battre();
  }

  async onClose() {
    if (this.platine) { this.platine.demonter(); this.platine = null; }
    // Plus personne ne regarde peut-être : le greffon recalculera de lui-même.
    this.greffon.replanifier();
  }
}

/* =========================================================================
 * Le panneau flottant, sur le modèle du panier d'annotations d'Ariane :
 * un cadre en position fixe dans la fenêtre d'Obsidian, déplaçable par son
 * en-tête et redimensionnable par son coin. Ce n'est pas une fenêtre système.
 * ========================================================================= */

class PanneauFlottant {
  constructor(greffon) {
    this.greffon = greffon;
    this.evenements = [];
  }

  ecouter(cible, type, fn) {
    cible.addEventListener(type, fn);
    this.evenements.push([cible, type, fn]);
  }

  ouvrir() {
    if (this.el) { this.el.addClass('vinyle-flottant-appel'); return; }
    const pos = this.greffon.reglages.flottantPosition || {};

    const el = document.createElement('div');
    el.className = 'vinyle-flottant';
    // L'étagère occupe une bande sous le plateau : ouvrir trop petit donnerait
    // un disque riquiqui dès la première fois.
    el.style.width = Math.max(220, pos.largeur || 360) + 'px';
    el.style.height = Math.max(240, pos.hauteur || 580) + 'px';
    if (pos.gauche != null && pos.haut != null) {
      el.style.left = pos.gauche + 'px';
      el.style.top = pos.haut + 'px';
    } else {
      el.style.top = '90px';
      el.style.right = '34px';
    }

    const entete = el.createDiv({ cls: 'vinyle-flottant-entete' });
    entete.createSpan({ cls: 'vinyle-flottant-titre', text: 'Lecteur de disque' });
    const fermer = entete.createSpan({ cls: 'vinyle-flottant-fermer', text: '✕' });
    fermer.setAttribute('aria-label', 'Fermer');
    this.ecouter(fermer, 'click', () => this.fermer());

    const corps = el.createDiv({ cls: 'vinyle-flottant-corps' });

    document.body.appendChild(el);
    this.el = el;
    this.rendreDeplacable(el, entete);
    this.platine = new Platine(this.greffon, corps).monter();

    // Le coin de redimensionnement est natif : on retient la taille choisie.
    const vue = el.ownerDocument.defaultView || window;
    if (typeof vue.ResizeObserver === 'function') {
      this.suivi = new vue.ResizeObserver(() => this.memoriser());
      this.suivi.observe(el);
    }
    this.greffon.battre();
  }

  fermer() {
    if (!this.el) return;
    this.memoriser();
    if (this.suivi) { this.suivi.disconnect(); this.suivi = null; }
    if (this.platine) { this.platine.demonter(); this.platine = null; }
    for (const [cible, type, fn] of this.evenements) cible.removeEventListener(type, fn);
    this.evenements = [];
    this.el.remove();
    this.el = null;
    this.greffon.replanifier();
  }

  basculer() {
    if (this.el) this.fermer(); else this.ouvrir();
  }

  memoriser() {
    if (!this.el) return;
    const r = this.el.getBoundingClientRect();
    this.greffon.reglages.flottantPosition = {
      gauche: Math.round(r.left), haut: Math.round(r.top),
      largeur: Math.round(r.width), hauteur: Math.round(r.height),
    };
    // On n'écrit sur le disque qu'une fois le geste terminé.
    if (this.sauvegarde) window.clearTimeout(this.sauvegarde);
    this.sauvegarde = window.setTimeout(() => this.greffon.sauver(), 600);
  }

  rendreDeplacable(el, poignee) {
    let sx = 0, sy = 0, ox = 0, oy = 0, actif = false;
    const surMouvement = (e) => {
      if (!actif) return;
      // On garde le panneau attrapable : jamais entièrement hors de l'écran.
      const l = Math.min(window.innerWidth - 60, Math.max(-el.offsetWidth + 80, ox + e.clientX - sx));
      const h = Math.min(window.innerHeight - 40, Math.max(0, oy + e.clientY - sy));
      el.style.left = l + 'px';
      el.style.top = h + 'px';
      el.style.right = 'auto';
    };
    const surRelache = () => {
      if (!actif) return;
      actif = false;
      document.removeEventListener('mousemove', surMouvement);
      document.removeEventListener('mouseup', surRelache);
      this.memoriser();
    };
    this.ecouter(poignee, 'mousedown', (e) => {
      if (e.target && e.target.classList && e.target.classList.contains('vinyle-flottant-fermer')) return;
      const rect = el.getBoundingClientRect();
      ox = rect.left; oy = rect.top; sx = e.clientX; sy = e.clientY;
      el.style.left = rect.left + 'px';
      el.style.top = rect.top + 'px';
      el.style.right = 'auto';
      actif = true;
      document.addEventListener('mousemove', surMouvement);
      document.addEventListener('mouseup', surRelache);
      e.preventDefault();
    });
  }
}

/* =========================================================================
 * Choisir un disque à poser sur l'étagère
 * ========================================================================= */

class SelecteurDisque extends obsidian.FuzzySuggestModal {
  constructor(app, greffon) {
    super(app);
    this.greffon = greffon;
    this.entrees = [];
    this.setPlaceholder('Chargement de votre bibliothèque…');
    this.setInstructions([{ command: '↵', purpose: "ajouter à l'étagère" }]);
  }

  async onOpen() {
    super.onOpen();
    // Les albums arrivent vite, les listes demandent une seconde : on affiche
    // ce qui est prêt plutôt que de faire attendre devant une fenêtre vide.
    const [listes, albums] = await Promise.all([listerListes(), listerAlbums()]);
    this.entrees = listes.concat(albums);
    this.setPlaceholder(this.entrees.length
      ? 'Chercher parmi ' + listes.length + ' listes et ' + albums.length + ' albums…'
      : 'Music est injoignable.');
    // Forcer le recalcul de la liste maintenant que les données sont là.
    if (this.inputEl) this.inputEl.dispatchEvent(new Event('input'));
  }

  getItems() { return this.entrees; }

  getItemText(item) {
    return (item.type === 'liste' ? 'Liste · ' : 'Album · ') + item.nom;
  }

  onChooseItem(item) {
    this.greffon.ajouterEtagere(item);
  }
}

/* =========================================================================
 * Réglages
 * ========================================================================= */

class OngletVinyle extends obsidian.PluginSettingTab {
  constructor(app, greffon) {
    super(app, greffon);
    this.greffon = greffon;
  }

  display() {
    const { containerEl: c } = this;
    c.empty();
    const g = this.greffon;
    const maj = async () => {
      await g.sauver();
      for (const platine of g.platines()) platine.appliquerOptions();
      g.peindre();
      g.replanifier();
    };

    new obsidian.Setting(c).setName('Le disque').setHeading();

    new obsidian.Setting(c)
      .setName('Taille automatique')
      .setDesc('Le disque prend la place disponible et suit le redimensionnement du volet ou de la fenêtre.')
      .addToggle((t) => t.setValue(g.reglages.tailleAuto !== false)
        .onChange(async (v) => { g.reglages.tailleAuto = v; await maj(); this.display(); }));

    if (g.reglages.tailleAuto !== false) {
      new obsidian.Setting(c)
        .setName('Taille maximale')
        .setDesc("En pixels. Le disque ne dépassera pas cette taille, même dans une grande fenêtre.")
        .addSlider((s) => s.setLimits(200, 900, 20)
          .setValue(g.reglages.tailleMax || 460).setDynamicTooltip()
          .onChange(async (v) => { g.reglages.tailleMax = v; await maj(); }));
    } else {
      new obsidian.Setting(c)
        .setName('Taille du disque')
        .setDesc('En pixels, quelle que soit la taille du volet.')
        .addSlider((s) => s.setLimits(140, 520, 10)
          .setValue(g.reglages.tailleDisque || 300).setDynamicTooltip()
          .onChange(async (v) => { g.reglages.tailleDisque = v; await maj(); }));
    }

    new obsidian.Setting(c)
      .setName('Montrer le bras')
      .setDesc('Il se pose sur le disque quand la lecture commence.')
      .addToggle((t) => t.setValue(g.reglages.montrerBras)
        .onChange(async (v) => { g.reglages.montrerBras = v; await maj(); }));

    new obsidian.Setting(c)
      .setName('Montrer la progression')
      .addToggle((t) => t.setValue(g.reglages.montrerProgression)
        .onChange(async (v) => { g.reglages.montrerProgression = v; await maj(); }));

    new obsidian.Setting(c).setName("L'étagère").setHeading();

    new obsidian.Setting(c)
      .setName("Montrer l'étagère")
      .setDesc("Vos listes et albums, en disques, à côté de la platine. Glissez-en un sur le plateau pour le lancer, double-cliquez pour le même effet, clic droit pour le retirer.")
      .addToggle((t) => t.setValue(g.reglages.montrerEtagere !== false)
        .onChange(async (v) => {
          g.reglages.montrerEtagere = v;
          await maj();
          for (const platine of g.platines()) platine.rendreEtagere();
        }));

    new obsidian.Setting(c)
      .setName('Garnir')
      .setDesc((g.reglages.etagere || []).length + ' disque(s) sur l\'étagère.')
      .addButton((b) => b.setButtonText('Ajouter un disque').setCta()
        .onClick(() => new SelecteurDisque(this.app, g).open()));

    new obsidian.Setting(c).setName('Le son').setHeading();
    const aideSon = c.createEl('div', { cls: 'setting-item-description' });
    aideSon.setText('Les trois bruits du tourne-disque sont calculés par le greffon, '
      + "jamais téléchargés ni enregistrés : du bruit passé dans des filtres. Rien ne "
      + "sort de votre machine, et rien ne se fait entendre avant votre premier geste "
      + 'sur le bras.');

    new obsidian.Setting(c)
      .setName('Les bruits du bras')
      .setDesc('Le frottement du sillon quand vous déplacez le bras, le saphir qui se pose, '
        + 'et le bras qui regagne son lit.')
      .addToggle((t) => t.setValue(g.reglages.sons !== false)
        .onChange(async (v) => {
          g.reglages.sons = v;
          if (!v && g.bruiteur) g.bruiteur.fermer();
          await maj();
        }));

    new obsidian.Setting(c)
      .setName('Volume')
      .setDesc('Le son se superpose à votre musique : il vaut mieux le garder discret.')
      .addSlider((sl) => sl.setLimits(0, 100, 5)
        .setValue(Math.round((g.reglages.volumeSons == null ? 0.5 : g.reglages.volumeSons) * 100))
        .setDynamicTooltip()
        .onChange(async (v) => { g.reglages.volumeSons = v / 100; await maj(); }))
      .addExtraButton((b) => b.setIcon('play').setTooltip('Écouter')
        .onClick(() => { if (g.bruiteur) g.bruiteur.poserSaphir(); }));

    new obsidian.Setting(c).setName('Ouverture').setHeading();

    new obsidian.Setting(c)
      .setName('Ouvrir le panneau flottant')
      .setDesc("L'icône du ruban ouvre un panneau posé par-dessus Obsidian, déplaçable par son en-tête et redimensionnable par son coin, plutôt que le volet latéral. La commande de bascule reste disponible dans les deux cas.")
      .addToggle((t) => t.setValue(g.reglages.flottantParDefaut === true)
        .onChange(async (v) => { g.reglages.flottantParDefaut = v; await maj(); }));

    new obsidian.Setting(c).setName("Barre d'état").setHeading();

    new obsidian.Setting(c)
      .setName("Afficher dans la barre d'état")
      .setDesc('Un disque miniature et le titre, en bas de la fenêtre.')
      .addToggle((t) => t.setValue(g.reglages.montrerBarreEtat)
        .onChange(async (v) => {
          g.reglages.montrerBarreEtat = v;
          if (v) g.creerBarreEtat(); else g.detruireBarreEtat();
          await maj();
        }));

    new obsidian.Setting(c)
      .setName('Masquer quand rien ne joue')
      .addToggle((t) => t.setValue(g.reglages.masquerEnPause)
        .onChange(async (v) => { g.reglages.masquerEnPause = v; await maj(); }));

    new obsidian.Setting(c)
      .setName('Format du texte')
      .setDesc('Jetons : {{titre}}, {{artiste}}, {{album}}.')
      .addText((t) => t.setValue(g.reglages.formatBarre)
        .onChange(async (v) => { g.reglages.formatBarre = v; await maj(); }));

    new obsidian.Setting(c)
      .setName('Longueur maximale')
      .setDesc('En caractères, au-delà le texte est coupé.')
      .addSlider((s) => s.setLimits(10, 90, 1)
        .setValue(g.reglages.longueurMaxBarre).setDynamicTooltip()
        .onChange(async (v) => { g.reglages.longueurMaxBarre = v; await maj(); }));

    new obsidian.Setting(c).setName('Interrogation de Music').setHeading();
    const aide = c.createEl('div', { cls: 'setting-item-description' });
    aide.setText("Le greffon n'interroge Music que si le volet ou la barre d'état est visible. "
      + 'Sinon il se tait complètement.');

    new obsidian.Setting(c)
      .setName('Pendant la lecture')
      .setDesc('En millisecondes entre deux interrogations.')
      .addSlider((s) => s.setLimits(1000, 10000, 500)
        .setValue(g.reglages.cadenceLecture).setDynamicTooltip()
        .onChange(async (v) => { g.reglages.cadenceLecture = v; await maj(); }));

    new obsidian.Setting(c)
      .setName("À l'arrêt")
      .addSlider((s) => s.setLimits(2000, 30000, 1000)
        .setValue(g.reglages.cadencePause).setDynamicTooltip()
        .onChange(async (v) => { g.reglages.cadencePause = v; await maj(); }));
  }
}
