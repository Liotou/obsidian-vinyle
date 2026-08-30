# Vinyle

> 🤖 **Written by vibe coding with Claude.** This plugin was designed and written
> in conversation with Claude (Anthropic). I am not a developer. I describe what
> I need, I test, I correct, and the code takes shape through the exchange. I say this up front, out of
> honesty, so you know what you are installing. The code is readable, commented,
> and has no dependency: a single `main.js` file, no TypeScript, no bundler, no
> `npm`, and not one binary asset — the record and the tonearm are drawn in CSS
> and inline SVG.
>
> *Français : voir [README.fr.md](README.fr.md).*

💿 **A turntable inside Obsidian.** The artwork of the Apple Music track you are
playing spins on a record, in a movable pane, in a floating panel, or in the
status bar. The tonearm is not decoration: it advances through the track, you
grab it to seek, you lift it to pause.

![Vinyle in an Obsidian pane](docs/vinyle.gif)

🍏 **macOS only, and Apple Music only.** Everything goes through AppleScript. No
API key, no network, no account, no developer certificate. The plugin asks
Music.app what it is playing, and Music.app answers.

---

## 🧭 Table of contents

- [⚠️ Before you start](#-before-you-start)
- [💿 The turntable](#-the-turntable)
- [🎚️ The tonearm, as a control](#-the-tonearm-as-a-control)
- [🗄️ The shelf](#-the-shelf)
- [🖼️ The gallery](#-the-gallery)
- [🖱️ Drag and drop](#-drag-and-drop)
- [🔊 The sound](#-the-sound)
- [📊 The status bar](#-the-status-bar)
- [🪟 The floating panel](#-the-floating-panel)
- [⚙️ Settings](#-settings)
- [⌨️ Commands](#-commands)
- [🚧 What Apple Music does not allow](#-what-apple-music-does-not-allow)
- [📦 Installing](#-installing)
- [☕ Buy me a coffee](#-buy-me-a-coffee)
- [⚖️ Licence](#-licence)

---

## ⚠️ Before you start

The first time the plugin talks to Music.app, macOS asks whether Obsidian may
control it. **You have to say yes**, otherwise nothing happens at all.

If you clicked the wrong button, or never saw the dialog, open *System Settings
→ Privacy & Security → Automation*, find Obsidian, and tick Music. The plugin
tells you so once per session, and only once: it will not nag you.

When Music.app is not running, the plugin stays quiet. No notice, no empty
record, nothing.

---

## 💿 The turntable

The artwork of the current track spins in the middle of the record. The vinyl
shows around it as a ring, with grooves, a label and a spindle hole. A fixed
highlight sits on the platter while the record turns underneath, because a
highlight that turned with the record would give the drawing away.

The rotation is pure CSS. No JavaScript runs while you listen, so a long
listening session costs nothing.

The record follows the size of its pane. A `ResizeObserver` measures what is
actually left once the titles, the controls and the progress bar have taken
their share, rather than guessing it. A ceiling keeps a large screen from giving
you an absurd record, and a fixed size remains available.

A slim fader sits beside the platter, for **Music's own volume** — not your
Mac's. It follows your hand on screen at once, while the command reaches Music
at most five times a second: writing the volume costs 187 ms, so sending one per
pixel would choke it. Move it up while the arm is raised and the sound comes
back, arm and fader agreeing rather than fighting.

`prefers-reduced-motion` turns off the rotation and every transition.

---

## 🎚️ The tonearm, as a control

The tonearm advances towards the centre as the track plays, and **you can grab
it**. Its angle is your position in the track: drag it inwards to go forward,
outwards to go back. The time shown tells you where you will land, and nothing
is sent to Music until you let go.

Lift it clear of the record and **the sound cuts out** — the platter keeps
turning, exactly as a real one does when the stylus leaves the groove.
Set it back down and the sound returns, at the point the groove has reached
under it, because the record never stopped. It is the gesture of a real
turntable, not a metaphor bolted on afterwards.

Three gestures, three meanings, and no two doing the same thing: the **button**
pauses, the **raised arm** mutes, **putting the record away** stops. If you quit
with the arm up, the plugin unmutes Music on its way out — but only if it was
the one that muted it.

The travel stops well before the label, at 18 % of the radius, as it would on a
real record.

---

## 🗄️ The shelf

Under the platter sits a shelf of square sleeves. You put on it whatever you
like, chosen from a fuzzy picker over **your playlists and your albums**.

Sleeve artwork is kept on disk and in memory. Twenty records at two hundred
milliseconds each would mean four seconds of waiting every time you open the
pane, so it is paid for once.

When the frame is wider than it is tall, the shelf stands as a column to the
right of the platter. Otherwise it runs as a strip underneath. The size
calculation accounts for both.

---

## 🖼️ The gallery

Click a sleeve and it opens, in a drawer beneath the shelf, **the gallery of its
tracks**: one record per track, with its title and artist underneath. Click a
record and that track goes on the platter.

This is the answer to a real limitation. Apple Music exposes no queue at all
(see [below](#-what-apple-music-does-not-allow)), so the plugin cannot show you
what comes next. It shows you what **you** chose to put within reach instead.

Two things make it fast. The titles and artists of a whole playlist come back in
a single query, about two hundred milliseconds whatever its size — measured at
199 ms for a 933-track playlist. And the artwork, which costs about two hundred
milliseconds *each*, is never fetched in bulk: every record appears bare, and
its sleeve settles onto it as Music hands it over, starting with what is in
view.

**A record on the platter is no longer in the crate.** Its slot stays where it
was, hollow, and fills back in when the music moves on or when you put the
record away. **Click the empty slot and the record comes back to it**, which
stops playback. The empty slot follows what Music is *actually* playing, not what you
clicked, so it keeps up even when a playlist rolls on by itself.

The records fall into place one after another, each landing with a small squash.
Opening another sleeve without closing the drawer slides the old gallery out to
the left and brings the new one in from the right.

---

## 🖱️ Drag and drop

**Onto the platter.** Drag a sleeve from the shelf to play the whole record, or
a single track from the gallery to play just that one. A dropped record does not
slide in from the side the way an automatic track change does: it settles where
your hand let it go, arriving slightly too large, sinking in, then coming to
rest.

**Off the platter.** Drag the record itself into the shelf to **put it away**,
which stops playback. The record comes to hover just above its sleeve, then
slides down behind it, and the sleeve hides it as it goes in.

Putting a record away and lifting the tonearm are not the same thing. The arm
**suspends**; putting the record away **stops** it, back to the beginning, and
the platter goes dark. Two gestures, two meanings.

---

## 🔊 The sound

Three sounds, and only three. The **groove rasping** while you drag the tonearm,
rising in pitch the faster your hand goes and falling silent when it stops. The
**stylus setting down** when you drop the arm on the record. The **arm returning
to its rest** when you lift it clear.

They are **computed, never recorded**: noise through filters, a few dozen lines.
There is no audio file in this repository, no download, nothing leaves your
machine. The audio context only opens on your first gesture on the arm, so
nothing can startle you on load.

Both a switch and a volume slider live in the settings. The sound plays over
your music, so it is meant to stay discreet, and it can be turned off entirely.

## 📊 The status bar

A tiny spinning record, the current track, and the three usual controls:
previous, play or pause, next. Clicking anywhere else on the item opens the
turntable.

The text is yours to shape, with `{{title}}`, `{{artist}}` and `{{album}}`, and
you can cap its length. You can also have the whole thing disappear when nothing
is playing.

---

## 🪟 The floating panel

A frame you can drag by its header, resize from its corner, and close with a
cross. It floats above your vault and follows you from note to note. Its
position and size are remembered, written to disk six hundred milliseconds after
you stop moving so as not to save at every pixel.

It is not a system window: it is a frame laid over Obsidian's own page. The pane
version, on the other hand, is a real `ItemView`, so you can put it in a
sidebar, in a main tab, or in a window torn off from Obsidian itself.

---

## ⚙️ Settings

- **Polling rates.** Two seconds while playing, six while stopped, both
  adjustable. And **when nobody is looking — no pane open, no panel shown, the
  status bar off — the plugin does not poll at all.**
- **Record size.** Automatic with a ceiling, or fixed.
- **Show the tonearm**, the progress bar, the shelf, the status bar item.
- **Hide the status bar item when paused.**
- **The shelf itself**, which you fill from the picker.
- **The sound of the arm**, and its volume.

---

## ⌨️ Commands

| Command | What it does |
| --- | --- |
| Open the turntable | In a pane, or in the floating panel, as you set it |
| Show or hide the floating panel | Toggles it |
| Add a record to the shelf | Opens the picker over playlists and albums |
| Play or pause | |
| Next track | |
| Previous track | |

---

## 🚧 What Apple Music does not allow

Worth knowing before you file an issue, because these are not oversights.

**There is no queue.** The AppleScript dictionary exposes `current playlist`,
`next track` and the playback modes, and nothing else. `current playlist` fails
outright when playback comes from a streamed album. The `index of current track`
matches no addressable list. And a streamed track is not in your local library,
so looking it up by album returns nothing. The tracks that are "up next" in
Apple Music's own sense are simply unreadable. Hence the shelf and the gallery:
what is within reach is what you put there.

**Albums are often single tracks.** In a library built from streaming, most
"albums" hold exactly one song. That is why the gallery goes down to the track:
whether an album holds one song or sixteen stops mattering once you pick the
track yourself.

**Radio has no artwork.** The platter stays bare, with its label. No broken
image.

---

## 📦 Installing

**With BRAT (recommended)**

1. install the [BRAT](https://github.com/TfTHacker/obsidian42-brat) plugin;
2. run the command "BRAT: Add a beta plugin for testing";
3. paste `Liotou/obsidian-vinyle`.

BRAT follows the releases of this repository and offers you updates.

**By hand**

Download `main.js`, `manifest.json` and `styles.css` from the
[latest release](../../releases/latest) and drop them into
`YourVault/.obsidian/plugins/vinyle/`.

**Requirements**

macOS, Obsidian on the desktop, and Music.app. Nothing else. No `npm`, no build
step, no API key, no account.

---

## ☕ Buy me a coffee

If Vinyle makes your work a little more pleasant, you can buy me a coffee.

[![Buy me a coffee](https://img.buymeacoffee.com/button-api/?text=Buy%20me%20a%20coffee&emoji=&slug=liotou&button_colour=FFDD00&font_colour=000000&font_family=Cookie&outline_colour=000000&coffee_colour=ffffff)](https://buymeacoffee.com/liotou)

I said at the top that this plugin was written by vibe coding with Claude, and I
stand by it. But a model does not know that a highlight must stay still while
the record turns, nor that lifting the arm should pause and putting a record
away should stop, nor how a record ought to slide into its sleeve. All of that
came from looking at it, finding it wrong, and saying so, over and over. The
code is not mine. The plugin is. ☕

---

## 🙏 Thanks

**[Music Player](https://github.com/TracingOrigins/obsidian-music-player-plugin)**
for the shape: platter, record, circular artwork, an arm that comes down,
rotation driven by `animation-play-state`.

**[Mac Now Playing](https://github.com/hajorda/obsidian-mac-now-playing)** for
the principle: native AppleScript, no API key, no network, no developer account.

---

## ⚖️ Licence

MIT, see [LICENSE](LICENSE).
