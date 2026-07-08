// Plays a recorded "unlock click" sound. Browsers only allow audio to start
// from/near an actual user gesture, so `primeAudio()` must be called
// synchronously inside a click/submit handler - creating/resuming the
// AudioContext later (e.g. inside a setTimeout) gets silently blocked. Once
// primed, `scheduleUnlockClick()` uses the audio clock itself (not
// setTimeout) for sample-accurate timing.
let ctx = null;
let bufferPromise = null;

function loadBuffer() {
  if (!bufferPromise) {
    const url = `${import.meta.env.BASE_URL}sounds/unlock-click.mp3`;
    bufferPromise = fetch(url)
      .then((res) => res.arrayBuffer())
      .then((data) => ctx.decodeAudioData(data));
  }
  return bufferPromise;
}

export function primeAudio() {
  if (!ctx) {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return null;
    ctx = new Ctx();
  }
  if (ctx.state === "suspended") ctx.resume().catch(() => {});
  loadBuffer().catch(() => {});
  return ctx;
}

export function scheduleUnlockClick(delaySeconds) {
  if (!ctx) return;
  loadBuffer()
    .then((buffer) => {
      const src = ctx.createBufferSource();
      src.buffer = buffer;
      src.connect(ctx.destination);
      src.start(ctx.currentTime + delaySeconds);
    })
    .catch(() => { /* audio unavailable/blocked; splash still shows fine */ });
}
