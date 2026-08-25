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
  tailleDisque: 300,      // px
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
    suivant: 'next track',
    precedent: 'previous track',
  };
  const v = verbes[ordre];
  if (!v) return Promise.resolve(false);
  return osascript(['-e', `tell application "Music" to ${v}`], 4000)
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

    this.registerView(TYPE_VUE, (feuille) => new VueVinyle(feuille, this));

    this.addRibbonIcon('disc-3', 'Vinyle', () => this.ouvrirVue());

    this.addCommand({
      id: 'ouvrir',
      name: 'Vinyle : ouvrir le tourne-disque',
      callback: () => this.ouvrirVue(),
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
  }

  async sauver() {
    await this.saveData(this.reglages);
  }

  /* --- Volet --- */

  async ouvrirVue() {
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
    return this.vues().length > 0 || !!this.barre;
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

    for (const v of this.vues()) v.peindre(p, this.urlPochette);
  }
};

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
    const c = this.contentEl;
    c.empty();
    c.addClass('vinyle-vue');

    this.plateau = c.createDiv({ cls: 'vinyle-plateau' });
    this.bras = this.plateau.createDiv({ cls: 'vinyle-bras' });
    this.bras.innerHTML =
      '<svg viewBox="0 0 40 150" aria-hidden="true">'
      + '<circle cx="20" cy="14" r="11" class="vinyle-pivot"/>'
      + '<rect x="17" y="12" width="6" height="112" rx="3" class="vinyle-tige"/>'
      + '<rect x="12" y="120" width="16" height="22" rx="3" class="vinyle-cellule"/>'
      + '</svg>';

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

    this.appliquerTaille();
    this.peindre(this.greffon.piste, this.greffon.urlPochette);
    // Le volet vient de s'ouvrir : on relance le sondage, qui dormait peut-être.
    this.greffon.battre();
  }

  bouton(parent, icone, infobulle, ordre) {
    const b = parent.createEl('button', { cls: 'vinyle-bouton' });
    obsidian.setIcon(b, icone);
    b.setAttribute('aria-label', infobulle);
    this.registerDomEvent(b, 'click', async () => {
      b.addClass('vinyle-occupe');
      await commander(ordre);
      b.removeClass('vinyle-occupe');
      this.greffon.battre(true);
    });
    return b;
  }

  appliquerTaille() {
    const t = Math.max(140, Math.min(520, this.greffon.reglages.tailleDisque || 300));
    this.contentEl.style.setProperty('--vinyle-taille', t + 'px');
    this.bras.toggleClass('vinyle-invisible', !this.greffon.reglages.montrerBras);
    this.zoneProgression.toggleClass('vinyle-invisible', !this.greffon.reglages.montrerProgression);
  }

  peindre(piste, urlPochette) {
    if (!this.plateau) return;
    const joue = !!(piste && piste.etat === 'lecture');
    const enPiste = !!(piste && piste.titre);

    this.disque.toggleClass('vinyle-tourne', joue);
    this.plateau.toggleClass('vinyle-actif', enPiste);
    this.bras.toggleClass('vinyle-pose', joue);

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
    const remplie = this.jauge.firstElementChild;
    if (remplie) remplie.style.width = part.toFixed(2) + '%';
    this.temps.setText(enPiste ? duree(pos) + ' / ' + duree(total) : '');
  }

  async onClose() {
    // Plus personne ne regarde peut-être : le greffon recalculera de lui-même.
    this.greffon.replanifier();
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
      for (const v of g.vues()) { v.appliquerTaille(); v.peindre(g.piste, g.urlPochette); }
      g.peindre();
      g.replanifier();
    };

    new obsidian.Setting(c).setName('Le disque').setHeading();

    new obsidian.Setting(c)
      .setName('Taille du disque')
      .setDesc('En pixels. Le volet reste utilisable de 140 à 520.')
      .addSlider((s) => s.setLimits(140, 520, 10)
        .setValue(g.reglages.tailleDisque).setDynamicTooltip()
        .onChange(async (v) => { g.reglages.tailleDisque = v; await maj(); }));

    new obsidian.Setting(c)
      .setName('Montrer le bras')
      .setDesc('Il se pose sur le disque quand la lecture commence.')
      .addToggle((t) => t.setValue(g.reglages.montrerBras)
        .onChange(async (v) => { g.reglages.montrerBras = v; await maj(); }));

    new obsidian.Setting(c)
      .setName('Montrer la progression')
      .addToggle((t) => t.setValue(g.reglages.montrerProgression)
        .onChange(async (v) => { g.reglages.montrerProgression = v; await maj(); }));

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
