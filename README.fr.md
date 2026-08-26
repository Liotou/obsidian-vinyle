# Vinyle

> 🤖 **Écrit en vibe coding avec Claude.** Ce greffon a été conçu et programmé en
> conversation avec Claude (Anthropic), à partir des besoins réels d'un
> doctorant. Je ne suis pas développeur. Je décris ce dont j'ai besoin, je
> teste, je corrige, et le code prend forme au fil des échanges. Je le dis
> d'emblée, par honnêteté, pour que vous sachiez ce que vous installez. Le code
> est lisible, commenté, et sans dépendance : un seul fichier `main.js`, ni
> TypeScript, ni bundler, ni `npm`, et pas la moindre ressource binaire — le
> disque et le bras sont dessinés en CSS et en SVG en ligne.
>
> *English: see [README.md](README.md).*

💿 **Un tourne-disque dans Obsidian.** La pochette du morceau Apple Music en
cours tourne sur un vinyle, dans un volet déplaçable, dans un panneau flottant
ou dans la barre d'état. Le bras n'est pas décoratif : il avance au fil du
morceau, on le saisit pour se déplacer dedans, on le relève pour mettre en
pause.

🍏 **macOS uniquement, et Apple Music uniquement.** Tout passe par AppleScript.
Pas de clé API, pas de réseau, pas de compte, pas de certificat de développeur.
Le greffon demande à Music.app ce qu'il joue, et Music.app répond.

---

## 🧭 Sommaire

- [⚠️ Avant de commencer](#-avant-de-commencer)
- [💿 Le tourne-disque](#-le-tourne-disque)
- [🎚️ Le bras, organe de commande](#-le-bras-organe-de-commande)
- [🗄️ L'étagère](#-létagère)
- [🖼️ La galerie](#-la-galerie)
- [🖱️ Le glisser-déposer](#-le-glisser-déposer)
- [🔊 Le son](#-le-son)
- [📊 La barre d'état](#-la-barre-détat)
- [🪟 Le panneau flottant](#-le-panneau-flottant)
- [⚙️ Réglages](#-réglages)
- [⌨️ Commandes](#-commandes)
- [🚧 Ce qu'Apple Music ne permet pas](#-ce-quapple-music-ne-permet-pas)
- [📦 Installation](#-installation)
- [☕ Offrez-moi un café](#-offrez-moi-un-café)
- [⚖️ Licence](#-licence)

---

## ⚠️ Avant de commencer

La première fois que le greffon s'adresse à Music.app, macOS vous demande si
Obsidian a le droit de le piloter. **Il faut répondre oui**, sans quoi rien ne
se passera.

Si vous avez cliqué à côté, ou si la boîte de dialogue vous a échappé, allez
dans *Réglages Système → Confidentialité et sécurité → Automatisation*, trouvez
Obsidian, et cochez Musique. Le greffon vous le signale une fois par session, et
une seule : il ne vous harcèlera pas.

Quand Music.app n'est pas lancé, le greffon se tait. Pas de notification, pas de
disque vide, rien.

---

## 💿 Le tourne-disque

La pochette du morceau en cours tourne au cœur du disque. Le vinyle reste
visible en couronne autour d'elle, avec ses sillons, son étiquette et son trou.
Un reflet fixe est posé sur le plateau tandis que le disque tourne dessous, car
un reflet qui tournerait avec le disque trahirait le dessin.

La rotation est entièrement au CSS. Aucun JavaScript n'intervient pendant que
vous écoutez, donc une écoute prolongée ne coûte rien.

Le disque suit la taille de son volet. Un `ResizeObserver` mesure ce qui reste
réellement disponible une fois les textes, les commandes et la progression
servis, plutôt que de le deviner. Un plafond évite qu'un grand écran ne donne un
disque démesuré, et un mode fixe reste disponible.

`prefers-reduced-motion` coupe la rotation et toutes les transitions.

---

## 🎚️ Le bras, organe de commande

Le bras avance vers le centre au fil du morceau, et **il se saisit à la souris**.
Sa position angulaire est votre position dans le morceau : tirez-le vers
l'intérieur pour avancer, vers l'extérieur pour revenir. Le temps affiché montre
où vous tomberez, et rien n'est envoyé à Music tant que vous n'avez pas lâché.

Relevé hors du disque, il **met en pause**. Reposé sur un disque à l'arrêt, il
**relance la lecture**. C'est le geste du tourne-disque, pas une métaphore
ajoutée après coup.

La course s'arrête bien avant l'étiquette, à 18 % du rayon, comme sur un disque
réel.

---

## 🗄️ L'étagère

Sous le plateau se range une étagère de pochettes carrées. Vous y mettez ce que
vous voulez, choisi dans un sélecteur flou parmi **vos listes de lecture et vos
albums**.

Les pochettes sont conservées sur le disque et en mémoire. Vingt disques à deux
cents millisecondes l'extraction feraient quatre secondes d'attente à chaque
ouverture du volet : elles ne se paient qu'une fois.

Quand le cadre est plus large que haut, l'étagère se dresse en colonne à droite
du plateau. Sinon elle passe en bande dessous. Le calcul de taille en tient
compte, dans les deux sens.

---

## 🖼️ La galerie

Cliquez sur une pochette : elle ouvre, dans un tiroir sous l'étagère, **la
galerie de ses morceaux**, un disque par piste, avec le titre et l'artiste
dessous. Cliquez un disque, ce morceau se pose sur la platine.

C'est la réponse à une vraie limite. Apple Music n'expose aucune file d'attente
(voir [plus bas](#-ce-quapple-music-ne-permet-pas)), le greffon ne peut donc pas
vous montrer ce qui vient ensuite. Il vous montre à la place ce que **vous**
avez mis à portée de main.

Deux choses la rendent rapide. Les titres et les artistes de toute une liste
reviennent en une seule interrogation, environ deux cents millisecondes quelle
que soit sa taille : mesuré à 199 ms pour une liste de 933 pistes. Et les
pochettes, qui coûtent deux cents millisecondes *chacune*, ne sont jamais tirées
en bloc : chaque disque paraît nu, et sa pochette vient s'y poser à mesure que
Music la rend, en commençant par ce qui est sous vos yeux.

**Un disque posé sur la platine n'est plus dans le bac.** Son emplacement
demeure, vide, et se rebouche quand la musique change ou quand vous rangez le
disque. Le trou suit ce que Music joue vraiment, et non ce que vous avez
cliqué : il reste donc juste même quand une liste s'enchaîne toute seule.

Les disques tombent les uns après les autres, chacun s'écrasant légèrement à
l'atterrissage. Ouvrir une autre pochette sans refermer le tiroir fait sortir
l'ancienne galerie vers la gauche et entrer la nouvelle par la droite.

---

## 🖱️ Le glisser-déposer

**Vers le plateau.** Glissez une pochette de l'étagère pour lancer le disque
entier, ou un seul morceau de la galerie pour ne lancer que celui-là. Un disque
déposé n'entre pas par le côté comme lors d'un changement automatique : il se
cale là où votre main l'a lâché, arrivant un peu trop grand, s'enfonçant, puis
reprenant sa taille.

**Depuis le plateau.** Glissez le disque lui-même dans l'étagère pour **le
ranger**, ce qui arrête la lecture. Le disque vient se placer juste au-dessus de
sa pochette, puis y descend en passant derrière elle, qui le cache à mesure
qu'il entre.

Ranger un disque et relever le bras ne sont pas la même chose. Le bras
**suspend** ; ranger le disque **arrête**, remet au début, et éteint le plateau.
Deux gestes, deux sens.

---

## 🔊 Le son

Trois bruits, et trois seulement. Le **frottement du sillon** pendant que vous
déplacez le bras, qui monte en fréquence à mesure que votre main va vite et se
tait dès qu'elle s'arrête. Le **saphir qui se pose** quand vous reposez le bras
sur le disque. Le **bras qui regagne son lit** quand vous le relevez.

Ils sont **calculés, jamais enregistrés** : du bruit passé dans des filtres,
quelques dizaines de lignes. Il n'y a aucun fichier audio dans ce dépôt, aucun
téléchargement, et rien ne sort de votre machine. Le contexte audio ne s'ouvre
qu'à votre premier geste sur le bras : rien ne peut vous surprendre au
chargement.

Un interrupteur et un réglage de volume sont dans les préférences. Le son se
superpose à votre musique, il est donc fait pour rester discret, et il se coupe
entièrement.

## 📊 La barre d'état

Un disque miniature qui tourne, le morceau en cours, et les trois commandes
habituelles : précédent, lecture ou pause, suivant. Un clic ailleurs sur
l'élément ouvre le tourne-disque.

Le texte se met en forme à votre goût, avec `{{titre}}`, `{{artiste}}` et
`{{album}}`, et sa longueur se plafonne. L'élément peut aussi disparaître
entièrement quand rien ne joue.

---

## 🪟 Le panneau flottant

Un cadre qui se déplace par son en-tête, se redimensionne par son coin et se
ferme par une croix. Il flotte au-dessus de votre coffre et vous suit de note en
note. Sa position et sa taille sont retenues, l'écriture sur disque étant
différée de six cents millisecondes pour ne pas sauvegarder à chaque pixel du
glissement.

Ce n'est pas une fenêtre système : c'est un cadre posé sur la page d'Obsidian.
La version en volet, elle, est une vraie `ItemView`, donc plaçable dans une
barre latérale, en onglet principal, ou dans une fenêtre détachée par Obsidian
lui-même.

---

## ⚙️ Réglages

- **Les cadences d'interrogation.** Deux secondes en lecture, six à l'arrêt,
  réglables. Et **quand personne ne regarde — aucun volet ouvert, aucun panneau
  affiché, la barre d'état coupée — le greffon n'interroge plus du tout.**
- **La taille du disque.** Automatique avec un plafond, ou fixe.
- **Afficher le bras**, la progression, l'étagère, l'élément de barre d'état.
- **Masquer l'élément de barre à l'arrêt.**
- **L'étagère elle-même**, que vous garnissez depuis le sélecteur.
- **Le son du bras**, et son volume.

---

## ⌨️ Commandes

| Commande | Effet |
| --- | --- |
| Ouvrir le tourne-disque | En volet, ou en panneau flottant, selon votre réglage |
| Afficher ou masquer le panneau flottant | Bascule |
| Ajouter un disque à l'étagère | Ouvre le sélecteur sur vos listes et albums |
| Lecture ou pause | |
| Piste suivante | |
| Piste précédente | |

---

## 🚧 Ce qu'Apple Music ne permet pas

À savoir avant d'ouvrir un ticket, car ce ne sont pas des oublis.

**Il n'y a pas de file d'attente.** Le dictionnaire AppleScript expose
`current playlist`, `next track` et les modes de lecture, et rien d'autre.
`current playlist` échoue franchement quand la lecture vient d'un album en flux.
L'`index of current track` ne correspond à aucune liste adressable. Et une piste
en flux n'est pas dans la bibliothèque locale, donc la chercher par album ne
rend rien. Les morceaux « suivants » au sens d'Apple Music sont tout simplement
illisibles. D'où l'étagère et la galerie : ce qui est à portée est ce que vous y
avez mis.

**Les albums n'ont souvent qu'une piste.** Dans une bibliothèque bâtie sur le
flux, la plupart des « albums » ne contiennent qu'un morceau. C'est pourquoi la
galerie descend jusqu'à la piste : qu'un album en contienne une ou seize cesse
d'avoir de l'importance dès lors que vous choisissez le morceau vous-même.

**La radio n'a pas de pochette.** Le plateau reste nu, avec son étiquette. Pas
d'image cassée.

---

## 📦 Installation

**Avec BRAT (recommandé)**

1. installez le greffon [BRAT](https://github.com/TfTHacker/obsidian42-brat) ;
2. lancez la commande « BRAT: Add a beta plugin for testing » ;
3. collez `Liotou/obsidian-vinyle`.

BRAT suit les publications de ce dépôt et vous propose les mises à jour.

**À la main**

Téléchargez `main.js`, `manifest.json` et `styles.css` depuis la
[dernière publication](../../releases/latest) et déposez-les dans
`VotreCoffre/.obsidian/plugins/vinyle/`.

**Il vous faut**

macOS, Obsidian sur ordinateur, et Music.app. Rien d'autre. Pas de `npm`, pas
d'étape de compilation, pas de clé API, pas de compte.

---

## ☕ Offrez-moi un café

Si Vinyle rend votre travail un peu plus agréable, vous pouvez m'offrir un café.

[![Offrez-moi un café](https://img.buymeacoffee.com/button-api/?text=Buy%20me%20a%20coffee&emoji=&slug=liotou&button_colour=FFDD00&font_colour=000000&font_family=Cookie&outline_colour=000000&coffee_colour=ffffff)](https://buymeacoffee.com/liotou)

J'ai dit en tête de page que ce greffon avait été écrit en vibe coding avec
Claude, et je le maintiens. Mais un modèle ne sait pas qu'un reflet doit rester
immobile pendant que le disque tourne, ni que relever le bras doit suspendre
quand ranger le disque doit arrêter, ni de quelle façon un disque entre dans sa
pochette. Tout cela est venu de l'avoir regardé, d'avoir trouvé que ça n'allait
pas, et de l'avoir dit, encore et encore. Le code n'est pas de moi. Le greffon,
si. ☕

---

## 🙏 Remerciements

**[Music Player](https://github.com/TracingOrigins/obsidian-music-player-plugin)**
pour la forme : plateau, disque, pochette circulaire, bras qui se pose, rotation
par `animation-play-state`.

**[Mac Now Playing](https://github.com/hajorda/obsidian-mac-now-playing)** pour
le principe : AppleScript natif, sans clé API, sans réseau, sans compte
développeur.

---

## ⚖️ Licence

MIT, voir [LICENSE](LICENSE).
