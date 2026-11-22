# Ladder League Manager

Runs a doubles pickleball ladder league: roster, weekly pools set by rating, courtside score entry with large buttons, and standings.

- **Pools:** players attending are ranked by rating and split into pools of about eight. The organiser can move anyone.
- **Schedule:** a pool of eight plays 7 rounds, partnering everyone once and opposing everyone twice. Pools of 4 to 12 get an even schedule.
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

Anyone with the link can read the league and enter scores during a live session. Only the organiser account can change players, pools, sessions or finished scores. The Firebase config values are not secret; the database rules are what protect the data.

## Local server

```
python server.py
```

Needs Python 3.10 or later and nothing else. It prints the address for other devices and creates `data/config.json` with the organiser PIN on first run.

## Tests

```
node tests/core.test.js
python -m unittest discover -s tests
```

The Python tests and the rating comparison need league data that is not in this repository, and skip themselves without it.
