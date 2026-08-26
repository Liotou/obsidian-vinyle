# Vinyle — note de conception

Greffon Obsidian pour macOS : la pochette de la piste Apple Music en cours
tourne sur un disque, dans un volet déplaçable et dans la barre d'état.

## Ce dont il s'inspire

- [Music Player](https://github.com/TracingOrigins/obsidian-music-player-plugin)
  pour la forme : empilement plateau, disque, pochette circulaire, bras qui se
  pose, rotation par `animation-play-state`.
- [Mac Now Playing](https://github.com/hajorda/obsidian-mac-now-playing) pour le
  principe : AppleScript natif, sans clé API, sans réseau, sans compte
  développeur.

Deux écarts assumés. Music Player livre des PNG de disque et de bras ; ici tout
est dessiné en CSS et en SVG en ligne, donc le greffon tient en un `main.js` et
un `styles.css`, sans bundler ni ressource binaire. Mac Now Playing n'affiche la
pochette que pour Spotify ; `raw data of artwork 1 of current track` la sort
aussi d'Apple Music, ce qui est la condition même du vinyle.

## Le pont vers Music.app

Une seule interrogation AppleScript renvoie tout ce qu'il faut, séparé par des
tabulations : état, identifiant persistant, titre, artiste, album, position,
durée, présence d'une pochette. Mesuré à environ 12 ms de processeur par appel.

Trois décisions structurent le coût :

1. **Ne jamais sonder quand personne ne regarde.** Si aucun volet n'est ouvert
   et que la barre d'état est désactivée, le minuteur n'est pas replanifié du
   tout. C'est la leçon du panneau de suggestions d'Ariane, qui chauffait la
   machine faute de savoir s'arrêter.
2. **Cadence adaptative.** Deux secondes en lecture, six à l'arrêt, réglables.
3. **La pochette ne sort qu'au changement de piste**, détecté par l'identifiant
   persistant. Elle pèse environ un mégaoctet ; l'extraire à chaque battement
   serait absurde.

La pochette est écrite par AppleScript dans le dossier du greffon, relue par
Node, puis servie en URL de données. Passer par `getResourcePath` obligerait à
déjouer le cache, le nom de fichier étant constant, et rien ne garantit qu'un
chemin sous `.obsidian` y soit servi.

**Piège de localisation.** Music renvoie les nombres dans la langue du système :
`125,501998` en français. Un `parseFloat` direct s'arrête à la virgule et rend
125, sans erreur. D'où `nombreLocal`, qui normalise avant de convertir.

**Garde-fou de délai.** Si `osascript` se bloque sur une boîte de dialogue
système, le processus est tué après le délai imparti. Vérifié : rendu en 1508 ms
pour un délai de 1500 ms, aucun processus résiduel.

## Le volet

Une `ItemView` de type `vinyle-tourne-disque`, donc plaçable dans n'importe quel
volet, y compris en onglet principal ou en fenêtre détachée.

Le disque tourne, le reflet non : le reflet est posé sur le plateau, en
`conic-gradient` fixe, tandis que les sillons et la pochette tournent en
dessous. Un reflet qui tournerait avec le disque trahirait le dessin.

La rotation est entièrement CSS, `animation-play-state` bascule entre `running`
et `paused`. Aucun JavaScript n'intervient pendant la lecture, donc une écoute
prolongée ne coûte rien.

`prefers-reduced-motion` coupe rotation et transition.

## Taille et fenêtre

Le disque suit le volet. Un `ResizeObserver` mesure ce qui reste réellement
disponible, en soustrayant la hauteur occupée par les textes et la progression,
plutôt qu'en la devinant : elle change avec un titre sur deux lignes, avec la
progression masquée, et avec la taille de police du thème. Un plafond réglable
évite qu'un grand écran ne donne un disque démesuré ; un mode fixe reste
disponible.

Deux pièges traités. La gouttière de défilement est réservée en permanence
(`scrollbar-gutter: stable`) : sans cela, l'apparition d'une barre réduirait la
largeur, donc le disque, donc la hauteur, donc la barre disparaîtrait, et
l'observateur oscillerait sans fin. Et un seuil de deux pixels empêche qu'une
écriture de la variable CSS ne relance l'observateur en boucle.

Le rendu du disque vit dans une classe **`Platine`**, indépendante de son
contenant. Deux hôtes s'en servent : le volet (`ItemView`) et le panneau
flottant. Sans cette séparation il faudrait écrire deux fois le disque, les
commandes et le calcul de taille, et les deux copies divergeraient à la première
retouche.

Le **panneau flottant** suit le panier d'annotations d'Ariane : un cadre en
`position: fixed` posé sur `document.body`, déplaçable par son en-tête, fermé
par une croix, redimensionnable par le coin natif (`resize: both`). Ce n'est pas
une fenêtre système. Sa position et sa taille sont retenues, l'écriture sur
disque étant différée de six cents millisecondes pour ne pas sauvegarder à
chaque pixel du glissement. Le déplacement est borné pour qu'il ne parte jamais
entièrement hors de l'écran, et `onunload` le retire, faute de quoi un cadre
posé sur `document.body` survivrait au déchargement du greffon.

L'observateur, `getComputedStyle` et `requestAnimationFrame` sont pris sur la
fenêtre propriétaire de l'élément et non sur la principale : le volet peut être
déplacé dans une fenêtre détachée par Obsidian lui-même, et le calcul cesserait
sinon de fonctionner.

Les marges autour du disque sont en `clamp()`, donc proportionnelles au cadre :
de 16 à 36 pixels sur les côtés. Mesuré, le disque garde de 36 à 40 pixels de
jeu de chaque côté dans le panneau, contre 12 auparavant.

## Le bras, organe de commande

Le bras n'est pas décoratif. Il avance vers le centre au fil du morceau, et se
saisit à la souris pour se déplacer dans la piste : sa position angulaire est la
position dans le morceau. Relevé hors du disque, il met en pause ; reposé sur le
disque à l'arrêt, il relance la lecture. C'est le geste du tourne-disque, pas une
métaphore ajoutée après coup.

Le pivot est situé en fraction du côté du plateau, `BRAS_PIVOT_X` et
`BRAS_PIVOT_Y`, valeurs qui découlent du `top`, `right`, `width` et
`transform-origin` de `.vinyle-bras` dans la feuille de style. Toucher à l'un
sans l'autre décalerait la prise. L'angle se lit du pointeur par
`atan2(-vx, vy)`, en partant du plateau, seul élément dont la boîte n'est pas
déformée par la rotation.

Course vérifiée par le calcul, le rayon étant rapporté au bord du disque :

| Angle | Rayon | Où tombe le saphir |
| --- | --- | --- |
| −26° | 1,53 | hors du disque, bras levé |
| −3° | 1,06 | juste au-delà du bord, seuil de pause |
| 2° | 0,95 | vinyle nu, début du morceau |
| 14° | 0,69 | vinyle nu, mi-parcours |
| 24° | 0,48 | sur la pochette, fin du morceau |

La course s'arrête bien avant l'étiquette, à 0,18, comme sur un disque réel.

Pendant le geste, ni le bras ni la jauge ne sont repeints par le battement, sans
quoi le bras sauterait sous le doigt toutes les deux secondes. Le temps affiché
montre où l'on tombera, sans rien commander tant que la souris n'est pas
relâchée.

**Second piège de localisation.** Music renvoie ses nombres avec une virgule
mais n'accepte qu'un point dans le script qu'on lui soumet : `set player
position to 73,786` est une erreur de syntaxe. L'échec était silencieux.
`toFixed` produit toujours un point, quel que soit le système.

## L'étagère

**Ce qui n'est pas possible.** Apple Music n'expose aucune file d'attente en
AppleScript : le dictionnaire ne donne que `current playlist`, `next track` et
les modes de lecture. Trois voies ont été essayées et fermées. `current
playlist` échoue quand la lecture vient d'un album en flux. L'`index of current
track` ne correspond à aucune liste adressable : la piste d'index 34 en lecture
n'est pas la piste 34 de `library playlist 1`. Et une piste en flux n'est pas
dans la bibliothèque locale, donc la chercher par album rend zéro résultat. Les
morceaux « suivants » au sens de la file d'Apple Music sont donc illisibles.

**Ce qui l'est.** Les listes de lecture et les albums de la bibliothèque, avec
la pochette de leur première piste. Mesuré : 63 listes non vides en 1,2 s, 785
albums distincts en 384 ms, une pochette en 200 ms, réduite de 104 Ko à 21 Ko en
21 ms par `sips`, livré avec macOS.

L'étagère contient donc ce que l'utilisateur y range, choisi dans un sélecteur
flou. Les pochettes sont conservées sur disque et en mémoire : vingt disques à
deux cents millisecondes feraient quatre secondes d'attente à chaque ouverture.
Un disque se glisse sur le plateau, se double-clique, ou se retire au clic droit.

L'étagère se dresse en colonne à droite du plateau quand le cadre est plus large
que haut, et passe en bande dessous sinon. Le calcul de taille en tient compte,
dans les deux sens.

## La galerie des morceaux

Une pochette de l'étagère ne lance plus rien par elle-même : elle ouvre, dans un
tiroir sous la bande, la galerie de ses morceaux. Un disque par morceau, son
titre et son artiste dessous, en grille défilante. Cliquer un disque le pose sur
la platine.

Ce détour règle un défaut mesuré : sur 786 albums de la bibliothèque, 719 ne
contiennent qu'une piste, soit 91 %. Un disque « album » ne pouvait donc lancer
qu'un morceau, et le sélecteur faisait défiler huit cents entrées dont
l'écrasante majorité étaient des morceaux isolés déguisés en albums. En
choisissant soi-même la piste, la question ne se pose plus.

**Ce que coûte l'ouverture.** Une seule interrogation rend les titres, les
artistes et les identifiants de base de toutes les pistes, en trois blocs
plutôt qu'en une boucle. Mesuré : 199 ms pour les 933 pistes de « Musique »,
198 ms pour les 351 de « Sans paroles », 189 ms pour 164. Le coût ne dépend pas
de la taille de la liste. Une boucle piste par piste aurait mis plusieurs
secondes. Réserve assumée : un titre contenant un retour à la ligne décalerait
les trois blocs ; on compare leurs longueurs et l'on renonce plutôt que
d'afficher des artistes décalés d'un cran.

**Ce que coûtent les pochettes.** Environ 200 ms chacune, mesuré de 173 à
201 ms. Les tirer toutes sur une liste de 351 titres ferait plus d'une minute.
Chaque disque paraît donc nu, et sa pochette vient s'y poser en fondu quand
Music la rend. Un `IntersectionObserver` ne demande que ce qui approche du champ
de vision, une file à un seul fil les sert l'une après l'autre, et changer de
disque abandonne les demandes en attente. Réduites par `sips -Z 160`, elles
tombent de 47 à 3 Ko, de 126 à 15 Ko.

**Comment on joue une piste.** Une liste se désigne par le rang, `play track N
of playlist`, ce qui donne à Music le contexte de la liste et donc
l'enchaînement de la suite, chose qu'aucune autre formulation ne permet. Un
album n'ayant pas de contexte jouable, on passe par le `database ID`, seul
identifiant stable de la bibliothèque.

**Le disque posé n'est plus dans le bac.** Sa case reste, vide, avec un cercle
en pointillés et son titre pâli, et elle se rebouche quand la musique change ou
qu'on range le disque. Le marquage se règle sur ce que Music joue réellement,
non sur ce qui a été cliqué : le rang aurait dit quel disque a été choisi, pas
lequel tourne, et le trou serait resté sur le morceau précédent dès que Music
enchaîne tout seul. Cela suppose de reconnaître la piste en cours parmi celles
de la galerie, or l'état de Music ne renvoie qu'un identifiant persistant quand
la galerie ne connaissait que l'identifiant de base. Un quatrième bloc dans la
même interrogation les donne tous les deux, sans coût mesurable : toujours
229 ms pour 933 pistes. Le parcours des cases n'a lieu qu'au changement de
piste, jamais à chaque battement.

## La chorégraphie du tiroir

Trois temps qui se chevauchent à l'ouverture. Le plateau descend à environ deux
tiers de sa taille en 260 ms. Dès 180 ms le tiroir s'ouvre en hauteur. À partir
de 300 ms les disques tombent en cascade, 46 ms d'écart, la cascade cessant de
se décaler après la douzième case pour ne pas traîner.

La chute est portée par deux éléments : la case fait la translation, le disque
qu'elle contient fait l'écrasement à l'atterrissage. Une seule `transform` par
élément, ici encore. L'ombre est large et lointaine en l'air, courte et serrée
une fois posée, sans quoi le disque semblerait glisser plutôt que tomber.

La fermeture se joue plus vite que l'ouverture : cascade inverse à 10 ms
d'écart, tiroir en 200 ms. Ouvrir une autre pochette sans refermer ne touche pas
au tiroir : l'ancienne galerie sort vers la gauche, la nouvelle entre par la
droite, du côté de l'étagère, comme les disques s'échangent.

Au clic, le disque quitte sa case dans un élément posé hors du flux, grandit et
vient prendre la place de celui du plateau. Animer la case elle-même
déplacerait la galerie sous le doigt.

**Le piège du rétrécissement.** Le plateau change de taille par sa largeur et sa
hauteur, jamais par `scale`, la transformation étant déjà prise par la rotation.
Et il ne rétrécit pas de lui-même : c'est le calcul de taille qui lui retranche
la hauteur du tiroir, la feuille de style l'y amenant en 260 ms.

**Le piège de la circularité.** La hauteur du tiroir ne peut pas être « ce qui
reste une fois le disque servi », puisque la taille du disque dépend du tiroir.
On procède donc dans l'ordre : la place disponible est mesurée d'abord, le
disque en prend ce qu'il veut, et le tiroir garde tout le reste, avec un
plancher de 110 pixels pour qu'une rangée entière tienne toujours. Ce que le
disque veut n'est pas seulement 63 % de la place : c'est le plus petit de ce
tiers-là, du plafond réglé et de la largeur disponible. Un premier jet
l'oubliait, et le tiroir s'arrêtait à sa part en laissant du vide sous lui dès
que la fenêtre grandissait. La hauteur réelle du tiroir n'est jamais mesurée
pendant qu'il s'ouvre, faute de quoi l'observateur lutterait contre sa propre
transition.

**Un arbitrage de place.** Dans un panneau de 290 sur 430, les commandes, les
titres et la progression prennent une centaine de pixels, et le tiroir n'y
laissait au disque que sa borne plancher. Le bloc des titres est donc effacé
tant que la galerie est ouverte : elle nomme déjà chaque morceau. En volet
large, la place ne manque pas et on ne l'efface pas, sans quoi le disque
grandirait à l'ouverture, ce qui prendrait le geste à rebours. Mesuré : disque
132 px et tiroir 110 px dans le panneau étroit, disque 352 px et tiroir 275 px
en volet large, disque 200 px et tiroir 372 px dans un panneau de 500 sur 760.

**Deux pièges de largeur.** Le conteneur centre ses enfants : sans largeur
explicite, le bac se repliait sur ses trois jaquettes et la galerie n'avait que
deux colonnes, étirées jusqu'à l'absurde. Et un disque de galerie garde une
taille fixe de 62 pixels, celle d'une pochette rangée : le laisser suivre sa
colonne le rendait démesuré dès qu'elles étaient peu nombreuses.

## Les deux gestes du disque

Un morceau de la galerie se glisse sur le plateau, et le disque du plateau se
glisse dans le bac pour être rangé. Au rangement, le disque vole du plateau vers
la jaquette de son disque si elle est sur l'étagère, sinon vers le bac.

**Un disque déposé ne s'échange pas, il se cale.** Le premier jet gardait
l'échange latéral du changement automatique, et le geste ressemblait alors à un
clic sur les boutons : le disque entrait par le côté, comme s'il avait été
choisi par la machine. Un dépôt pose donc son disque là où la main l'a lâché :
il arrive un peu plus grand, s'enfonce, puis reprend sa taille, l'ombre du
plateau se resserrant en même temps pour lui donner du poids. La transformation
va au porteur, l'ombre au plateau, une propriété par élément. Le drapeau qui
annonce la pose se périme au bout de quatre secondes, sans quoi un changement de
piste survenu bien plus tard en hériterait.

**Le disque entre dans sa pochette, il ne s'y fond pas.** Un premier jet le
posait sur la jaquette et l'effaçait en fondu, ce qui ne ressemblait à rien. Le
rangement se joue donc en deux temps : le disque vient se placer presque collé
au-dessus de la jaquette, puis y descend en passant sous le bac. La jaquette
étant opaque, elle le mange à mesure qu'il entre, ce qu'aucune opacité ne sait
imiter. La fin demande un ordre précis : éteindre le disque en fondu tout en lui
rendant son plan habituel le faisait reparaître un instant devant la pochette.
On coupe la transition, on l'éteint d'un coup pendant qu'il est encore derrière,
et on ne le remonte qu'ensuite. Cela suppose que la jaquette le soit vraiment : son fond était la
couleur de bordure du thème, souvent translucide, et il a fallu la poser sur le
fond primaire avec la teinte de bordure passée en liseré intérieur.

**Ranger arrête, le bras suspend.** Le bras relevé met en pause et reposé
reprend ; ranger le disque appelle `stop`, remet le morceau à zéro et éteint le
plateau. Deux gestes, deux sens. Leur donner le même effet aurait fait deux
chemins pour une seule chose.

La saisie du bras arrête la propagation de son `mousedown`, ce qui empêche le
glissement de démarrer : les deux gestes cohabitent sur le même disque sans se
gêner. Si l'étagère est masquée, il n'y a pas de cible où ranger et le
glissement est refusé dès son départ.

## Les bords

La galerie vient au ras des bords, comme un texte qui défile dans sa fenêtre.
Le cadre n'a donc plus de marge latérale ni basse : ce sont les textes qui
portent la leur, et le disque reçoit la sienne par le calcul de taille plutôt
que par la mise en page.

Un premier jet gardait le padding du cadre et en sortait le bac par des marges
négatives. Le conteneur défilant, ce qui débordait à gauche passait sous le bord
et devenait inatteignable : les premières colonnes de la galerie étaient
tranchées en volet intégré. La marge est maintenant posée en pixels par le
JavaScript, seule façon d'avoir la même valeur des deux côtés, un `clamp()` en
CSS ne se relisant pas depuis le script.

La gouttière de défilement reste réservée en permanence : la retirer ferait
osciller l'observateur, et cela vaut mieux qu'une dizaine de pixels gagnés à
droite.

## Les animations

L'échange de disque vit sur un **porteur** distinct : la translation est sur le
porteur, la rotation sur le disque qu'il contient. Une seule `transform` par
élément, faute de quoi l'une écrase l'autre.

Le disque sortant part vers la gauche en rapetissant, le suivant entre par la
droite, du côté de l'étagère. La pochette est remplacée à 380 ms, au creux du
mouvement, quand l'opacité est nulle : aucun clignotement. Rejouer l'animation
exige de retirer la classe, forcer un reflux, puis la remettre, sans quoi une
seconde piste enchaînée ne relancerait rien.

L'échange se déclenche seul au changement de piste, détecté par l'identifiant
persistant, et pas au premier rendu, où il n'y a rien à remplacer.

`prefers-reduced-motion` réduit l'échange à une milliseconde et coupe le
défilement doux.

## Le son

Trois bruits, calculés et non enregistrés : le frottement du sillon pendant le
déplacement du bras, le saphir qui se pose, le bras qui regagne son lit. Livrer
des fichiers audio aurait rompu la règle du greffon, qui n'a aucune ressource
binaire, et sa promesse d'être hors ligne. Ce sont donc du bruit blanc bouclé et
des filtres biquad, une centaine de lignes.

Le contexte audio n'est ouvert qu'au `mousedown` sur le bras. Ce n'est pas une
précaution de confort : le navigateur refuse d'ouvrir un contexte audio sans
geste humain, et l'ouvrir au chargement échouerait silencieusement.

Le frottement suit la vitesse de la main, pas celle du morceau. Un piège s'y
cache : main immobile, aucun événement ne vient, et le bruit resterait au
dernier niveau atteint. Un minuteur de quatre-vingt-dix millisecondes le fait
donc retomber de lui-même.

Le bruit précède la commande, qui met le temps d'un aller-retour avec Music. Le
faire suivre l'aurait décollé du geste.

Deux réglages l'accompagnent, l'interrupteur et le volume. Un greffon qui fait
du bruit sans qu'on puisse le faire taire est intenable, et celui-ci tourne
pendant qu'on travaille.

## Quand cela rate

| Situation | Comportement |
| --- | --- |
| Music.app pas lancé | Le greffon se tait, aucune notification |
| Autorisation d'automatisation refusée | Un message une seule fois par session, avec le chemin des Réglages système |
| Piste sans pochette (radio) | Plateau nu avec l'étiquette, pas d'image cassée |
| `osascript` bloqué | Processus tué après le délai |

## Vérifications passées

- Pont éprouvé sur la vraie bibliothèque : état lu, pochette extraite en 198 ms,
  PNG 800 × 800 valide, URL de données de 1 381 722 caractères.
- `nombreLocal` sur `125,501998`, `3.5`, chaîne vide, texte, `0,0`.
- Commandes : bascule effective puis état restauré à l'identique.
- Chemins d'erreur : script invalide, application absente, délai dépassé, refus
  d'autorisation correctement distingué d'une panne ordinaire.
- Module chargé hors d'Obsidian avec un faux `obsidian`, dix méthodes présentes.
- Pistes d'une liste tirées du vrai Music : 933, 351, 271 et 164 pistes, de 186
  à 230 ms ; noms à emoji corrects ; album de 16 pistes ; liste inexistante
  distinguée par un chemin d'erreur propre.
- Ordres de lecture et de tirage de pochette vérifiés par `osacompile`, sans
  être exécutés : quatre formes, plus un nom contenant un guillemet.
- Pochette d'une piste précise, tirée du vrai Music : 173 à 201 ms, JPEG valide,
  réduite de 47 à 3 Ko et de 126 à 15 Ko, URL de données non nulle. Le chemin
  d'erreur ne laisse aucun fichier derrière lui.
- Dimensionnement rejoué sur treize géométries : volet étroit, volet large, fenêtre
  flottante, volet plat, progression masquée, titre long, plafond abaissé, mode
  fixe. Dix appels sur une géométrie stable ne produisent qu'une seule écriture.

## Ce qui reste à faire

- Voir tourner la galerie dans Obsidian, ce que seul l'utilisateur peut faire.
  Rien de ce qui suit n'a été vu à l'écran : la chute des disques, le vol vers
  le plateau, le rétrécissement du plateau, et la lecture effective d'une piste
  choisie, qui n'a pas été lancée pour ne pas détourner son écoute.
- README bilingue et publication sur GitHub, une fois la chose validée.
