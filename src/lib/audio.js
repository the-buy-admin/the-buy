// Synthesized "unlock click" sound (two quick tone bursts), no audio file
// needed. Browsers only allow audio to start from/near an actual user
// gesture, so `primeAudio()` must be called synchronously inside a click
// handler - creating the AudioContext later (e.g. inside a setTimeout) gets
// silently blocked. Once primed, `scheduleUnlockClick()` uses the audio
// clock itself (not setTimeout) for sample-accurate timing.
let ctx = null;

export function primeAudio() {
  if (!ctx) {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return null;
    ctx = new Ctx();
  }
  if (ctx.state === "suspended") ctx.resume().catch(() => {});
  return ctx;
}

function click(time, freq, duration, gain) {
  const osc = ctx.createOscillator();
  const g = ctx.createGain();
  osc.type = "square";
  osc.frequency.setValueAtTime(freq, time);
  g.gain.setValueAtTime(0, time);
  g.gain.linearRampToValueAtTime(gain, time + 0.002);
  g.gain.exponentialRampToValueAtTime(0.0001, time + duration);
  osc.connect(g);
  g.connect(ctx.destination);
  osc.start(time);
  osc.stop(time + duration + 0.01);
}

export function scheduleUnlockClick(delaySeconds) {
  try {
    if (!ctx) return;
    const t0 = ctx.currentTime + delaySeconds;
    click(t0, 1800, 0.03, 0.25);
    click(t0 + 0.045, 900, 0.05, 0.18);
  } catch (err) { /* audio unavailable/blocked; splash still shows fine */ }
}
