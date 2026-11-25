# Ladder League Manager

Runs a doubles pickleball ladder league: roster, weekly pools set by rating, courtside score entry with large buttons, and standings.

- **Pools:** players attending are ranked by rating and split into pools of eight or nine where the numbers allow (tens and elevens rather than a seven; 23 players is an eleven and a twelve). Courts follow a pool's size (two from eight players, three for twelve) until the organiser sets them. The organiser can move anyone.
- **Schedule:** a pool of eight plays 7 rounds, partnering everyone once and opposing everyone twice. A pool of nine plays 9 rounds the same way, one player sitting out each round. Pools of 4 to 12 get an even schedule.
- **Scores:** tap the winning pair, tap the losing score, save. Any phone or tablet can enter a score while a session is live.
- **Ratings:** win chance from the gap between team averages, up to 0.100 for the result, a small score bonus. Each session is averaged over every order of its rounds, so a game counts the same whenever it was played.

## Three ways to run it

| Mode | Where the data lives | Use it for |
|---|---|---|
| Hosted (GitHub Pages + Firebase) | A Firebase Realtime Database, live on every device | Running the league |
| Local server (`python server.py`) | `data/league.json` on the laptop | A venue with no internet: devices join over the laptop's Wi-Fi or hotspot |
| Single device | That browser's storage | Trying it out |

The site in `docs/` picks the mode itself: Firebase if `docs/config.js` has the details, else the local server if it is being served by one, else single device.

## Hosted setup (about 10 minutes, once)

1. Go to <https://console.firebase.google.com>, create a project (Analytics not needed).
2. **Build > Realtime Database > Create database.** Start in locked mode.
3. In the database's **Rules** tab, replace everything with the contents of `database.rules.json` and publish.
4. **Build > Authentication > Get started > Email/Password > Enable.**
5. **Project settings > Your apps > Web app (`</>`)**, register it, and copy the `firebaseConfig` values into `docs/config.js`. Commit and push.
6. Open the site, go to **Organiser**, and create the organiser account. The first account created becomes the organiser; nobody else can claim it afterwards.
7. To bring in an existing league, **Organiser > Settings > Load a league file**.

**Organiser login is switched off for now.** `openOrganiser: true` in `docs/config.js` plus the open rules in `database.rules.json` mean anyone with the link can use the organiser tools, so save a copy (Organiser > Settings) before each session.

To switch the login back on: set `openOrganiser: false`, publish `database.rules.login.json` in the Rules tab, and sign in with the organiser account. With those rules anyone can read the league and enter scores during a live session, and only the organiser account can change players, pools, sessions or finished scores. The Firebase config values are not secret; the database rules are what protect the data.

## Availability and the league code

Players say in or out for each league night on the **Availability** page (hosted site and single-device mode; not on the laptop version). The organiser sets the season's nights and when answers close under Organiser, Settings. A new session starts with the players who said in. On a league night the organiser's "Who is playing" list is grouped by answer (In ticked, No answer, Out with a cross), and a tap there changes the list and that player's answer.

Each time a session is finished, the hosted site saves the whole league in the database (`copies/`), listed under Organiser, Settings, so any week can be rolled back. A restore does not touch players' answers.

**The league code** keeps strangers and scanners from changing anything. It is switched on in Firebase, once:

1. **Authentication > Sign-in method:** enable **Anonymous**. A device needs an id of its own to be filed as a member. No names or passwords are involved.
2. **Realtime Database > Rules:** paste `database.rules.code.json`, replace `PUT-THE-LEAGUE-CODE-HERE` (it appears twice) with the code, and publish. Do not commit the real code to this repository.
3. Under Organiser, Settings, type the same code to build the players' link, and send that link to the league. The code stays in the address, so a bookmark or home-screen icon keeps working.

With those rules: anyone can read the ladder; a change is only accepted from a device that has opened the link (or typed the code once); scores and round confirms are also accepted from any device while a session is live, so nobody is blocked at the courts. To change the code for a new season, edit it in the Rules tab and send the new link.

## Rounds for pools of eight and nine

Under Organiser, Settings: **Mixed** (the default: partners and order drawn afresh each night), **Fixed order** (the same whist rounds in the same order every night, slot 1 being the highest rating in the pool; in a nine the players sit out in slot order), or **Closest last** (the fixed games, reordered so the night ends on its closest round). With a fixed schedule the organiser can swap two players' slots in a pool. Changing the choice redraws a session that is still being set up. The order has no effect on ratings.

## Local server

```
python server.py
```

Needs Python 3.10 or later and nothing else. It prints the address for other devices and creates `data/config.json` on first run. The organiser PIN in that file is not asked for unless you add `"open": false` to it. Finishing a session works the ratings out away from the data lock, so other devices keep reading and scoring while it runs.

## Tests

```
node tests/core.test.js
node tests/backend.test.js
python -m unittest discover -s tests
```

`backend.test.js` drives the website's database code against an in-memory stand-in for Firebase (`tests/fake-firebase`), including a second device writing at the same moment. `tests/parity.json` holds numbers written by the JavaScript rating engine that the Python engine must reproduce.

The Python tests and the rating comparison need league data that is not in this repository, and skip themselves without it.
