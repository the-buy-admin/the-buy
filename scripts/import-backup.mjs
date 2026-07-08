#!/usr/bin/env node
// One-time script: imports a `the-buy-backup-*.json` export (from the
// Claude.ai era) into this app's Firebase Realtime Database, encrypting each
// value exactly the way the app itself does (AES-GCM, key derived from the
// shared login password). Run once, then it can be deleted/ignored.
//
// Usage:
//   node scripts/import-backup.mjs the-buy-backup-2026-07-07.json
//
// Note: order photos (order-img:*) are NOT part of the backup file and are
// therefore not touched by this script.

import { readFileSync } from "node:fs";
import { webcrypto as crypto } from "node:crypto";
import { initializeApp } from "firebase/app";
import { getAuth, signInWithEmailAndPassword } from "firebase/auth";
import { getDatabase, ref, get, set } from "firebase/database";
import { firebaseConfig, SHARED_EMAIL } from "../src/lib/firebase-config.js";

const VERIFIER_PLAINTEXT = "the-buy-verifier-v1";

function promptHidden(query) {
  return new Promise((resolve) => {
    const stdin = process.stdin;
    process.stdout.write(query);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf8");
    let input = "";
    const onData = (char) => {
      switch (char) {
        case "\n":
        case "\r":
        case "\u0004":
          stdin.setRawMode(false);
          stdin.pause();
          stdin.removeListener("data", onData);
          process.stdout.write("\n");
          resolve(input);
          break;
        case "\u0003": // Ctrl+C
          process.stdout.write("\n");
          process.exit(1);
          break;
        case "\u007f": // backspace
          input = input.slice(0, -1);
          process.stdout.clearLine(0);
          process.stdout.cursorTo(0);
          process.stdout.write(query + "*".repeat(input.length));
          break;
        default:
          input += char;
          process.stdout.write("*");
          break;
      }
    };
    stdin.on("data", onData);
  });
}

async function deriveKey(password, saltB64) {
  const enc = new TextEncoder();
  const salt = Uint8Array.from(Buffer.from(saltB64, "base64"));
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

async function encryptString(key, plain) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const enc = new TextEncoder();
  const cipherBuf = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, enc.encode(plain));
  const cipherBytes = new Uint8Array(cipherBuf);
  const combined = new Uint8Array(iv.length + cipherBytes.length);
  combined.set(iv, 0);
  combined.set(cipherBytes, iv.length);
  return Buffer.from(combined).toString("base64");
}

async function decryptString(key, b64) {
  const combined = Uint8Array.from(Buffer.from(b64, "base64"));
  const iv = combined.slice(0, 12);
  const cipherBytes = combined.slice(12);
  const plainBuf = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, cipherBytes);
  return new TextDecoder().decode(plainBuf);
}

function dbPathForKey(key) {
  return `data/${encodeURIComponent(key)}`;
}

async function main() {
  const filePath = process.argv[2];
  if (!filePath) {
    console.error("Usage: node scripts/import-backup.mjs <backup-file.json>");
    process.exit(1);
  }

  const backup = JSON.parse(readFileSync(filePath, "utf-8"));
  if (!backup || !backup.masters || !backup.entries) {
    console.error("This doesn't look like a valid The Buy backup file (missing masters/entries).");
    process.exit(1);
  }

  console.log(`Importing: ${filePath}`);
  console.log(`  brands: ${backup.masters.brands?.length ?? 0}`);
  console.log(`  seasons: ${backup.masters.seasons?.length ?? 0}`);
  console.log(`  entries: ${backup.entries?.length ?? 0}`);
  console.log(`  orders: ${backup.orders?.length ?? 0}`);
  console.log("");

  const password = await promptHidden("共通パスワード: ");

  const app = initializeApp(firebaseConfig);
  const auth = getAuth(app);
  const db = getDatabase(app);

  console.log("Firebaseにログイン中...");
  await signInWithEmailAndPassword(auth, SHARED_EMAIL, password);

  const saltSnap = await get(ref(db, "meta/salt"));
  if (!saltSnap.exists()) {
    console.error(
      "meta/salt が見つかりません。先にアプリを一度開いてログインし、初期セットアップを済ませてください。"
    );
    process.exit(1);
  }
  const key = await deriveKey(password, saltSnap.val());

  const verifierSnap = await get(ref(db, "meta/verifier"));
  if (verifierSnap.exists()) {
    try {
      const plain = await decryptString(key, verifierSnap.val());
      if (plain !== VERIFIER_PLAINTEXT) throw new Error("mismatch");
    } catch {
      console.error("パスワードが違います(検証用データの復号に失敗しました)。中断します。");
      process.exit(1);
    }
  }

  const toWrite = [
    ["bybrand:masters", backup.masters],
    ["bybrand:entries", backup.entries],
    ["bybrand:orders", backup.orders ?? []],
    ["bybrand:launchplan", backup.launchPlan ?? null],
  ];

  console.log("\n書き込み中(既存データは上書きされます)...");
  for (const [storageKey, value] of toWrite) {
    if (value === null) continue;
    const json = JSON.stringify(value);
    const encrypted = await encryptString(key, json);
    await set(ref(db, dbPathForKey(storageKey)), encrypted);
    console.log(`  \u2713 ${storageKey}`);
  }

  console.log("\nインポート完了。");
  console.log(
    "注意: 発注の写真データ(order-img:*)はこのバックアップに含まれていないため、インポートされていません。"
  );
  process.exit(0);
}

main().catch((err) => {
  console.error("\nエラー:", err && err.message ? err.message : err);
  process.exit(1);
});
