/* Firebase web app config: turns on shared live data.
   Set firebase to null and the site runs in single-device mode (data stays in this browser).
   These values are not secret: access is controlled by the database rules in database.rules.json. */
window.LADDER_CONFIG = {
  /* true: the Organiser tab needs no login (anyone with the link can manage the league).
     To bring the login back: set this to false and publish database.rules.login.json in Firebase. */
  openOrganiser: true,
  /* The page behind the league name in the top bar. Optional: leave club out and that page shows the court on its own. */
  club: {
    kicker: "Adelaide Pickleball Club · est. 2021",
    headline: ["Fast hands.", "Long rallies.", "Monday nights."],
    pitch: "Pickleball at Mile End. Two a side, a court you can cover in three steps, and rallies that will not end.",
    title: "Since 2021",
    /* champion: { label: "Sep-Oct ladder champion", name: "Name here", note: "optional line" },   last season's winner, when known */
    story: [
      ["2021", "Andrew Reilly talks Netball SA into letting us tape trial courts at Mile End Stadium. South Australia's first pickleball club is up and running."],
      ["2022", "Club players go to the national championships and come home with medals. They have done it at every nationals since."],
      ["2023", "Talia Saunders and Joel Carr win silver for SA in the states and territories teams event at the nationals."],
      ["2026", "The Wombats win the first Adelaide National Pickleball League season. 16 courts at Mile End, 12 more at Concordia College."],
    ],
    source: ["club's own story in the Pickleball Australia club spotlight, April 2026", "https://www.pickleballaus.org/club-spotlight-adelaide-pickleball-club"],
  },
  firebase: {
    apiKey: "AIzaSyBPd9hXvfXTefF2Q5Nv0rYctobTCcQfkV4",
    authDomain: "ladder-league-7c5db.firebaseapp.com",
    databaseURL: "https://ladder-league-7c5db-default-rtdb.asia-southeast1.firebasedatabase.app",
    projectId: "ladder-league-7c5db",
    storageBucket: "ladder-league-7c5db.firebasestorage.app",
    messagingSenderId: "404673449762",
    appId: "1:404673449762:web:7f0a9bce839273963e5f7b",
  },
};
