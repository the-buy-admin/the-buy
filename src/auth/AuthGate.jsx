import React, { useState } from "react";
import { login } from "../lib/storage.js";
import { primeAudio, scheduleUnlockClick } from "../lib/audio.js";
import { SPLASH_CLICK_MS } from "../lib/splashTiming.js";

const STYLES = {
  page: {
    minHeight: "100vh",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    background: "#FAFAF8",
    color: "#111110",
    fontFamily: "Inter, system-ui, sans-serif",
  },
  box: {
    width: 320,
    maxWidth: "90vw",
    padding: 32,
    border: "1px solid #111110",
    background: "#FFFFFF",
    boxSizing: "border-box",
  },
  title: { fontSize: 20, fontWeight: 600, marginBottom: 4, letterSpacing: 0.5 },
  sub: { fontSize: 13, opacity: 0.7, marginBottom: 20 },
  input: {
    width: "100%",
    padding: "10px 12px",
    fontSize: 15,
    border: "1px solid #111110",
    marginBottom: 12,
    background: "#FAFAF8",
    color: "#111110",
    boxSizing: "border-box",
  },
  button: {
    width: "100%",
    padding: "10px 12px",
    fontSize: 15,
    fontWeight: 600,
    background: "#111110",
    color: "#FAFAF8",
    border: "none",
    cursor: "pointer",
  },
  buttonDisabled: { opacity: 0.5, cursor: "default" },
  error: { color: "#B00020", fontSize: 13, marginBottom: 12, lineHeight: 1.5 },
  note: { fontSize: 12, opacity: 0.6, marginTop: 16, lineHeight: 1.5 },
};

function messageFor(err) {
  if (err && err.code === "storage/wrong-password") {
    return "パスワードが違います(保存されているデータの復号に失敗しました)。";
  }
  if (err && typeof err.code === "string" && err.code.startsWith("auth/")) {
    return "パスワードが違います。";
  }
  return "ログインに失敗しました。ネットワーク接続を確認してください。";
}

export default function AuthGate({ children }) {
  const [unlocked, setUnlocked] = useState(false);
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [firstTime, setFirstTime] = useState(false);

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!password || busy) return;
    // Must happen synchronously inside this click/submit gesture, or the
    // browser will silently block audio from starting later.
    primeAudio();
    setBusy(true);
    setError("");
    try {
      const result = await login(password);
      if (result.firstTimeSetup) setFirstTime(true);
      scheduleUnlockClick(SPLASH_CLICK_MS / 1000);
      setUnlocked(true);
    } catch (err) {
      setError(messageFor(err));
    } finally {
      setBusy(false);
    }
  };

  if (unlocked) return children;

  return (
    <div style={STYLES.page}>
      <form style={STYLES.box} onSubmit={handleSubmit}>
        <div style={STYLES.title}>THE BUY</div>
        <div style={STYLES.sub}>共通パスワードを入力してください</div>
        {error && <div style={STYLES.error}>{error}</div>}
        {firstTime && (
          <div style={STYLES.note}>
            初回セットアップ: このパスワードで今後のデータを暗号化します。
          </div>
        )}
        <input
          style={STYLES.input}
          type="password"
          autoFocus
          placeholder="パスワード"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          disabled={busy}
        />
        <button
          style={{ ...STYLES.button, ...(busy || !password ? STYLES.buttonDisabled : {}) }}
          type="submit"
          disabled={busy || !password}
        >
          {busy ? "確認中…" : "開く"}
        </button>
      </form>
    </div>
  );
}
