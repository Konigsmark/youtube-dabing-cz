/* Offscreen: zachytí zvuk (a volitelně obraz) karty, streamuje do Gemini Live API,
 * přehrává přeložené audio. Volitelně nahrává: VIDEO (.webm) a/nebo AUDIO (.wav, časově sedící). */
let ws = null, ready = false, captureStream = null;
let inCtx = null, procNode = null, srcNode = null;
let outCtx = null, nextTime = 0;
let collected = [], srcRate = 48000, sendTimer = null;
const audioBuffered = [];

// nahrávání
let recVideoOn = false, recAudioOn = false;
let videoRec = null, videoChunks = [], recDest = null;
let pcmTap = null, recPcm = [];

chrome.runtime.onMessage.addListener((msg) => {
  if (!msg || msg.target !== "offscreen") return;
  if (msg.type === "GEMINI_OFFSCREEN_START") start(msg).catch((e) => report("err", String(e)));
  if (msg.type === "GEMINI_OFFSCREEN_STOP") stop();
});

function report(kind, text) {
  try { chrome.runtime.sendMessage({ target: "background", type: "GEMINI_STATUS", kind, text }); } catch (e) {}
}

let recBase = "youtube-dabing";
async function start({ streamId, apiKey, lang, recordVideo, recordAudio, title }) {
  await stop();
  recVideoOn = !!recordVideo; recAudioOn = !!recordAudio;
  recBase = safeName(title) + "-dabing";

  const gum = { audio: { mandatory: { chromeMediaSource: "tab", chromeMediaSourceId: streamId } } };
  if (recVideoOn) gum.video = { mandatory: { chromeMediaSource: "tab", chromeMediaSourceId: streamId } };
  captureStream = await navigator.mediaDevices.getUserMedia(gum);

  inCtx = new AudioContext();
  try { await inCtx.resume(); } catch (e) {}
  srcRate = inCtx.sampleRate;
  srcNode = inCtx.createMediaStreamSource(captureStream);
  procNode = inCtx.createScriptProcessor(4096, 1, 1);
  srcNode.connect(procNode);
  procNode.connect(inCtx.destination);
  procNode.onaudioprocess = (e) => { collected.push(new Float32Array(e.inputBuffer.getChannelData(0))); };

  outCtx = new AudioContext();
  try { await outCtx.resume(); } catch (e) {}
  nextTime = 0;

  // --- příprava nahrávání ---
  videoRec = null; videoChunks = []; recDest = null; pcmTap = null; recPcm = [];
  if (recVideoOn || recAudioOn) recDest = outCtx.createMediaStreamDestination();

  if (recAudioOn) {
    // průchozí tap, který zaznamenává VÝSTUP včetně ticha (časově sedící WAV)
    pcmTap = outCtx.createScriptProcessor(4096, 1, 1);
    pcmTap.onaudioprocess = (e) => {
      const inp = e.inputBuffer.getChannelData(0);
      e.outputBuffer.getChannelData(0).set(inp);   // průchod do reproduktorů
      if (recAudioOn) recPcm.push(new Float32Array(inp));
    };
    pcmTap.connect(outCtx.destination);
  }

  if (recVideoOn) {
    try {
      const vtypes = ["video/webm;codecs=vp9,opus", "video/webm;codecs=vp8,opus", "video/webm"];
      let vmime = ""; for (const t of vtypes) { if (MediaRecorder.isTypeSupported(t)) { vmime = t; break; } }
      const vtrack = captureStream.getVideoTracks()[0];
      const atrack = recDest.stream.getAudioTracks()[0];
      const tr = []; if (vtrack) tr.push(vtrack); if (atrack) tr.push(atrack);
      videoRec = new MediaRecorder(new MediaStream(tr), vmime ? { mimeType: vmime } : undefined);
      videoRec.ondataavailable = (e) => { if (e.data && e.data.size) videoChunks.push(e.data); };
      videoRec.onstop = () => saveVideo();
      videoRec.start(1000);
    } catch (e) { report("err", "Nahrávání videa nelze spustit: " + e); }
  }
  if (recVideoOn || recAudioOn) report("info", "Nahrávám" + (recVideoOn ? " video" : "") + (recAudioOn ? " audio" : "") + "…");

  // --- WebSocket Gemini Live ---
  const url = "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=" + encodeURIComponent(apiKey);
  ws = new WebSocket(url);
  ws.onopen = () => {
    ws.send(JSON.stringify({
      setup: {
        model: "models/gemini-3.5-live-translate-preview",
        outputAudioTranscription: {},
        generationConfig: {
          responseModalities: ["AUDIO"],
          translationConfig: { targetLanguageCode: lang || "cs", echoTargetLanguage: false }
        }
      }
    }));
    report("info", "WS otevřen, posílám setup");
  };
  ws.onmessage = async (ev) => {
    let data = ev.data; if (data instanceof Blob) data = await data.text();
    let m; try { m = JSON.parse(data); } catch (e) { return; }
    if (m.setupComplete) { ready = true; flushBuffered(); report("info", "Gemini připraven, streamuji zvuk"); return; }
    const sc = m.serverContent; if (!sc) return;
    if (sc.outputTranscription && sc.outputTranscription.text) report("transcript", sc.outputTranscription.text);
    const parts = sc.modelTurn && sc.modelTurn.parts;
    if (parts) for (const p of parts) if (p.inlineData && p.inlineData.data) playPcm24(p.inlineData.data);
  };
  ws.onerror = () => report("err", "Chyba WebSocketu (klíč/limit?)");
  ws.onclose = (e) => { ready = false; report("info", "WS zavřen: " + (e.reason || e.code)); };

  sendTimer = setInterval(flushAudio, 100);
  report("info", "Zachytávám zvuk karty");
}

function flushAudio() {
  if (!collected.length) return;
  let total = 0; for (const a of collected) total += a.length;
  const buf = new Float32Array(total); let o = 0;
  for (const a of collected) { buf.set(a, o); o += a.length; }
  collected = [];
  const ratio = srcRate / 16000;
  const outLen = Math.floor(buf.length / ratio);
  const pcm = new Int16Array(outLen);
  for (let i = 0; i < outLen; i++) { const s = buf[Math.floor(i * ratio)] || 0; pcm[i] = Math.max(-1, Math.min(1, s)) * 0x7fff; }
  const payload = JSON.stringify({ realtimeInput: { audio: { data: b64FromBytes(new Uint8Array(pcm.buffer)), mimeType: "audio/pcm;rate=16000" } } });
  if (ready && ws && ws.readyState === WebSocket.OPEN) ws.send(payload); else audioBuffered.push(payload);
}
function flushBuffered() { while (audioBuffered.length && ws && ws.readyState === WebSocket.OPEN) ws.send(audioBuffered.shift()); }

function playPcm24(b64) {
  try {
    if (outCtx.state === "suspended") { outCtx.resume(); }
    const bytes = bytesFromB64(b64);
    const i16 = new Int16Array(bytes.buffer);
    const f32 = new Float32Array(i16.length);
    for (let i = 0; i < i16.length; i++) f32[i] = i16[i] / 0x8000;
    const ab = outCtx.createBuffer(1, f32.length, 24000);
    ab.copyToChannel(f32, 0);
    const node = outCtx.createBufferSource();
    node.buffer = ab;
    node.connect(pcmTap || outCtx.destination);   // přes tap (kvůli WAV) nebo přímo
    if (recDest) { try { node.connect(recDest); } catch (e) {} }
    const now = outCtx.currentTime;
    if (nextTime < now) nextTime = now + 0.05;
    node.start(nextTime);
    nextTime += ab.duration;
  } catch (e) { report("err", "play: " + e); }
}

// ---- ukládání ----
function saveVideo() {
  if (!videoChunks.length) return;
  const blob = new Blob(videoChunks, { type: (videoRec && videoRec.mimeType) || "video/webm" });
  download(blob, recBase + ".webm");
  report("info", "Video uloženo (" + Math.round(blob.size / 1048576) + " MB).");
  videoChunks = [];
}
function saveAudioWav() {
  if (!recPcm.length) return;
  const blob = encodeWav(recPcm, outCtx ? outCtx.sampleRate : 48000);
  download(blob, recBase + ".wav");
  report("info", "Audio (WAV) uloženo (" + Math.round(blob.size / 1048576) + " MB).");
  recPcm = [];
}
function encodeWav(chunks, rate) {
  let len = 0; for (const c of chunks) len += c.length;
  const pcm = new Int16Array(len); let o = 0;
  for (const c of chunks) { for (let i = 0; i < c.length; i++) { let s = Math.max(-1, Math.min(1, c[i])); pcm[o++] = s < 0 ? s * 0x8000 : s * 0x7fff; } }
  const buf = new ArrayBuffer(44 + pcm.length * 2);
  const dv = new DataView(buf);
  const ws_ = (off, str) => { for (let i = 0; i < str.length; i++) dv.setUint8(off + i, str.charCodeAt(i)); };
  ws_(0, "RIFF"); dv.setUint32(4, 36 + pcm.length * 2, true); ws_(8, "WAVE");
  ws_(12, "fmt "); dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 1, true);
  dv.setUint32(24, rate, true); dv.setUint32(28, rate * 2, true); dv.setUint16(32, 2, true); dv.setUint16(34, 16, true);
  ws_(36, "data"); dv.setUint32(40, pcm.length * 2, true);
  new Int16Array(buf, 44).set(pcm);
  return new Blob([buf], { type: "audio/wav" });
}
function download(blob, name) {
  const url = URL.createObjectURL(blob);
  if (chrome.downloads && chrome.downloads.download) {
    chrome.downloads.download({ url, filename: name, saveAs: true }, () => setTimeout(() => { try { URL.revokeObjectURL(url); } catch (e) {} }, 120000));
  } else {
    const a = document.createElement("a"); a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
  }
}
function safeName(t) {
  let n = (t || "youtube").replace(/[\\/:*?"<>|]/g, "-").replace(/[\x00-\x1f]/g, "").replace(/\s+/g, " ").trim();
  n = n.replace(/[ .]+$/, "");           // Windows nemá rád koncovou tečku/mezeru
  return n.slice(0, 120) || "youtube";
}

async function stop() {
  ready = false;
  if (sendTimer) { clearInterval(sendTimer); sendTimer = null; }
  collected = []; audioBuffered.length = 0;
  // dokonči nahrávky (video přes onstop, audio rovnou)
  if (videoRec && videoRec.state !== "inactive") { try { videoRec.stop(); } catch (e) {} }
  if (recAudioOn) { try { saveAudioWav(); } catch (e) {} }
  recAudioOn = false; recVideoOn = false;
  try { if (ws) ws.close(); } catch (e) {} ws = null;
  try { if (pcmTap) pcmTap.disconnect(); } catch (e) {} pcmTap = null;
  try { if (procNode) procNode.disconnect(); } catch (e) {}
  try { if (srcNode) srcNode.disconnect(); } catch (e) {}
  try { if (inCtx) await inCtx.close(); } catch (e) {} inCtx = null;
  try { if (outCtx) await outCtx.close(); } catch (e) {} outCtx = null;
  recDest = null;
  if (captureStream) { captureStream.getTracks().forEach((t) => t.stop()); captureStream = null; }
}

function b64FromBytes(bytes) { let s = ""; for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]); return btoa(s); }
function bytesFromB64(b64) { const bin = atob(b64); const u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); return u; }
