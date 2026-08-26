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
- Dimensionnement rejoué sur huit géométries : volet étroit, volet large, fenêtre
  flottante, volet plat, progression masquée, titre long, plafond abaissé, mode
  fixe. Dix appels sur une géométrie stable ne produisent qu'une seule écriture.

## Ce qui reste à faire

- Voir tourner le greffon dans Obsidian, ce que seul l'utilisateur peut faire.
- README bilingue et publication sur GitHub, une fois la chose validée.
