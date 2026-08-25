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

## Ce qui reste à faire

- Voir tourner le greffon dans Obsidian, ce que seul l'utilisateur peut faire.
- README bilingue et publication sur GitHub, une fois la chose validée.
