/* Firebase web app config: turns on shared live data.
   Set firebase to null and the site runs in single-device mode (data stays in this browser).
   These values are not secret: access is controlled by the database rules in database.rules.json. */
window.LADDER_CONFIG = {
  /* true: the Organiser tab needs no login (anyone with the link can manage the league).
     To bring the login back: set this to false and publish database.rules.login.json in Firebase. */
  openOrganiser: true,
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
