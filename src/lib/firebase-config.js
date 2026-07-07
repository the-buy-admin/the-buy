// Fill these in with the values from:
// Firebase Console > Project settings > General > Your apps > SDK setup and configuration
//
// These values are NOT secret - they only identify which Firebase project to talk
// to (this is normal for client-side Firebase apps). Actual access control is
// enforced by Firebase Authentication (the shared login) plus the Realtime
// Database security rules, and the data itself is additionally encrypted in the
// browser before it's ever sent (see storage.js), using a key derived from the
// same shared password.
export const firebaseConfig = {
  apiKey: "AIzaSyCi0r-p2IN0bMXM_4v86nfvENxHjG5TuvI",
  authDomain: "the-buy-e5087.firebaseapp.com",
  databaseURL: "https://the-buy-e5087-default-rtdb.firebaseio.com",
  projectId: "the-buy-e5087",
  storageBucket: "the-buy-e5087.firebasestorage.app",
  messagingSenderId: "707082161602",
  appId: "1:707082161602:web:afffe0af97e742781eda5b",
};

// The single shared login account used by both people. Firebase Authentication
// requires an email format, but this isn't used to send mail or identify a
// person - it's just a fixed username. The real secret is the password, entered
// on the login screen and never stored anywhere.
export const SHARED_EMAIL = "thebuy@internal.local";
