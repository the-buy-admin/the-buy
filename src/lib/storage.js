// Replacement for Claude.ai's window.storage.
//
// Data lives in Firebase Realtime Database so both people can see the same,
// live data from separate devices. Every value is encrypted client-side with a
// key derived (PBKDF2) from the shared login password *before* it ever leaves
// the browser - so even direct access to the Firebase project (console,
// misconfigured rules, etc.) doesn't expose plaintext prices/IPC amounts.
// The password itself is never stored or transmitted anywhere; only the
// derived key lives in memory for the duration of the session.
import { initializeApp } from "firebase/app";
import {
  getAuth,
  signInWithEmailAndPassword,
  signOut,
} from "firebase/auth";
import {
  getDatabase,
  ref,
  get as dbGet,
  set as dbSet,
  remove as dbRemove,
} from "firebase/database";
import { firebaseConfig, SHARED_EMAIL } from "./firebase-config.js";

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getDatabase(app);

const SALT_PATH = "meta/salt";
const VERIFIER_PATH = "meta/verifier";
const VERIFIER_PLAINTEXT = "the-buy-verifier-v1";

let cryptoKey = null; // in-memory only; never persisted to disk

function dbPathForKey(key) {
  // window.storage keys look like "bybrand:masters" or "order-img:abc123".
  // encodeURIComponent keeps them as a single safe path segment (RTDB keys
  // can't contain '.', '#', '$', '[', ']', '/').
  return `data/${encodeURIComponent(key)}`;
}

// Spreading a large Uint8Array into String.fromCharCode(...) blows the call
// stack (each byte becomes a function argument) once payloads get past a few
// tens of KB - easy to hit once an order carries several photos. Chunking
// keeps each fromCharCode call well under any engine's argument limit.
function bytesToBase64(bytes) {
  const chunkSize = 8192;
  let binary = "";
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

function randomSaltB64() {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return bytesToBase64(bytes);
}

async function deriveKey(password, saltB64) {
  const enc = new TextEncoder();
  const salt = Uint8Array.from(atob(saltB64), (c) => c.charCodeAt(0));
  const baseKey = await crypto.subtle.importKey(
    "raw",
    enc.encode(password),
    "PBKDF2",
    false,
    ["deriveKey"]
  );
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt, iterations: 150000, hash: "SHA-256" },
    baseKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );
}

async function encryptString(plain) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const enc = new TextEncoder();
  const cipherBuf = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    cryptoKey,
    enc.encode(plain)
  );
  const cipherBytes = new Uint8Array(cipherBuf);
  const combined = new Uint8Array(iv.length + cipherBytes.length);
  combined.set(iv, 0);
  combined.set(cipherBytes, iv.length);
  return bytesToBase64(combined);
}

async function decryptString(b64) {
  const combined = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  const iv = combined.slice(0, 12);
  const cipherBytes = combined.slice(12);
  const plainBuf = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv },
    cryptoKey,
    cipherBytes
  );
  return new TextDecoder().decode(plainBuf);
}

// Signs in with the shared account, then derives/verifies the encryption key.
// Throws on wrong password or network failure.
export async function login(password) {
  await signInWithEmailAndPassword(auth, SHARED_EMAIL, password);

  const saltSnap = await dbGet(ref(db, SALT_PATH));
  let salt = saltSnap.exists() ? saltSnap.val() : null;
  const firstTimeSetup = !salt;
  if (!salt) salt = randomSaltB64();

  cryptoKey = await deriveKey(password, salt);

  if (firstTimeSetup) {
    await dbSet(ref(db, SALT_PATH), salt);
    await dbSet(ref(db, VERIFIER_PATH), await encryptString(VERIFIER_PLAINTEXT));
    return { firstTimeSetup: true };
  }

  const verifierSnap = await dbGet(ref(db, VERIFIER_PATH));
  if (!verifierSnap.exists()) {
    await dbSet(ref(db, VERIFIER_PATH), await encryptString(VERIFIER_PLAINTEXT));
    return { firstTimeSetup: false };
  }
  try {
    const plain = await decryptString(verifierSnap.val());
    if (plain !== VERIFIER_PLAINTEXT) throw new Error("mismatch");
  } catch {
    cryptoKey = null;
    await signOut(auth);
    const err = new Error("Password does not match the stored data.");
    err.code = "storage/wrong-password";
    throw err;
  }
  return { firstTimeSetup: false };
}

export async function logout() {
  cryptoKey = null;
  await signOut(auth);
}

export function isUnlocked() {
  return cryptoKey !== null;
}

window.storage = {
  async get(key) {
    if (!cryptoKey) throw new Error("Storage is locked; log in first.");
    const snap = await dbGet(ref(db, dbPathForKey(key)));
    if (!snap.exists()) return null;
    const value = await decryptString(snap.val());
    return { value };
  },
  async set(key, value) {
    if (!cryptoKey) throw new Error("Storage is locked; log in first.");
    await dbSet(ref(db, dbPathForKey(key)), await encryptString(value));
  },
  async delete(key) {
    if (!cryptoKey) throw new Error("Storage is locked; log in first.");
    await dbRemove(ref(db, dbPathForKey(key)));
  },
};
