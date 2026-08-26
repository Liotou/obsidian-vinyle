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
};

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

// Extrait la pochette de la piste en cours vers un fichier. Music.app ne sait
// pas cibler une piste par identifiant sans la sélectionner, on prend donc
// « current track », ce qui suffit puisqu'on n'appelle ceci qu'au changement.
async function extrairePochette(cheminAbsolu) {
  const script = `
tell application "Music" to set d to raw data of artwork 1 of current track
set f to open for access POSIX file ${JSON.stringify(cheminAbsolu)} with write permission
set eof f to 0
write d to f
close access f
return "ok"
`;
  const r = await osascript(['-e', script], 8000);
  return !r.erreur && r.texte === 'ok';
}

function commander(ordre) {
  const verbes = {
    lecture: 'playpause',
    jouer: 'play',
    pause: 'pause',
    suivant: 'next track',
    precedent: 'previous track',
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
    this.registerDomEvent(this.barre, 'click', () => this.ouvrirVue());
  }

  detruireBarreEtat() {
    if (!this.barre) return;
    this.barre.remove();
    this.barre = null;
    this.disqueBarre = null;
    this.texteBarre = null;
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

  cheminPochette() {
    const rel = this.app.vault.configDir + '/plugins/' + this.manifest.id + '/pochette.png';
    const base = (this.app.vault.adapter && this.app.vault.adapter.basePath) || '';
    return { rel, abs: base ? path.join(base, rel) : null };
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
    try {
      const octets = fs.readFileSync(c.abs);
      this.urlPochette = 'data:image/png;base64,' + octets.toString('base64');
    } catch (e) {
      this.urlPochette = null;
    }
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

    this.disque = this.plateau.createDiv({ cls: 'vinyle-disque' });
    this.pochette = this.disque.createDiv({ cls: 'vinyle-pochette' });
    this.etiquette = this.disque.createDiv({ cls: 'vinyle-etiquette' });
    this.trou = this.disque.createDiv({ cls: 'vinyle-trou' });

    this.commandes = this.plateau.createDiv({ cls: 'vinyle-commandes' });
    this.btnPrec = this.bouton(this.commandes, 'skip-back', 'Piste précédente', 'precedent');
    this.btnJouer = this.bouton(this.commandes, 'play', 'Lecture ou pause', 'lecture');
    this.btnSuiv = this.bouton(this.commandes, 'skip-forward', 'Piste suivante', 'suivant');

    this.infos = c.createDiv({ cls: 'vinyle-infos' });
    this.elTitre = this.infos.createDiv({ cls: 'vinyle-titre' });
    this.elArtiste = this.infos.createDiv({ cls: 'vinyle-artiste' });
    this.elAlbum = this.infos.createDiv({ cls: 'vinyle-album' });

    this.zoneProgression = c.createDiv({ cls: 'vinyle-progression' });
    this.jauge = this.zoneProgression.createDiv({ cls: 'vinyle-jauge' });
    this.jauge.createDiv({ cls: 'vinyle-jauge-remplie' });
    this.temps = this.zoneProgression.createDiv({ cls: 'vinyle-temps' });

    this.ecouter(this.bras, 'mousedown', (e) => this.saisirBras(e));

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

    let t;
    if (!r.tailleAuto) {
      t = r.tailleDisque || 300;
    } else {
      const vue = el.ownerDocument.defaultView || window;
      const style = vue.getComputedStyle(el);
      const marges = parseFloat(style.paddingTop) + parseFloat(style.paddingBottom);
      const cotes = parseFloat(style.paddingLeft) + parseFloat(style.paddingRight);
      const ecart = parseFloat(style.rowGap) || 0;

      let occupe = marges;
      for (const enfant of [this.infos, this.zoneProgression]) {
        if (enfant && enfant.offsetParent !== null) occupe += enfant.offsetHeight + ecart;
      }
      t = Math.min(r.tailleMax || 460, el.clientWidth - cotes, el.clientHeight - occupe);
    }

    t = Math.round(Math.max(120, Math.min(900, t)));
    // Sans ce seuil, poser la variable relancerait l'observateur en boucle.
    if (this.tailleAppliquee != null && Math.abs(this.tailleAppliquee - t) < 2) return;
    this.tailleAppliquee = t;
    el.style.setProperty('--vinyle-taille', t + 'px');
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

    const bouger = (ev) => {
      this.angleSaisi = Math.max(BRAS_LEVE, Math.min(BRAS_FIN, this.angleDepuisPointeur(ev)));
      this.poserBras(this.angleSaisi);
      this.montrerApercu(this.angleSaisi);
    };
    const lacher = async () => {
      doc.removeEventListener('mousemove', bouger);
      doc.removeEventListener('mouseup', lacher);
      this.bras.removeClass('vinyle-bras-saisi');
      this.plateau.removeClass('vinyle-parcours');
      this.saisi = false;
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

    if (urlPochette) {
      this.pochette.style.backgroundImage = 'url("' + urlPochette + '")';
      this.pochette.removeClass('vinyle-sans-pochette');
    } else {
      this.pochette.style.backgroundImage = '';
      this.pochette.addClass('vinyle-sans-pochette');
    }

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
    el.style.width = Math.max(220, pos.largeur || 320) + 'px';
    el.style.height = Math.max(240, pos.hauteur || 420) + 'px';
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
