/* Service worker – cloudové TTS (ElevenLabs, Azure) mimo stránku kvůli CORS/CSP. */
chrome.runtime.onMessage.addListener((msg, _s, send) => {
  if (!msg) return;
  if (msg.type === "ELEVEN_TTS")   { elevenTTS(msg).then(send).catch((e)=>send({error:errstr(e)})); return true; }
  if (msg.type === "ELEVEN_VOICES"){ elevenVoices(msg.apiKey).then(send).catch((e)=>send({error:errstr(e)})); return true; }
  if (msg.type === "AZURE_TTS")    { azureTTS(msg).then(send).catch((e)=>send({error:errstr(e)})); return true; }
});
const errstr = (e) => String((e && e.message) || e);

function bufToB64(buf) {
  const bytes = new Uint8Array(buf); let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}
function escapeXml(s){ return String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;").replace(/'/g,"&apos;"); }

// ---- ElevenLabs ----
async function elevenTTS({ apiKey, voiceId, modelId, text }) {
  if (!apiKey) return { error: "Chybí ElevenLabs API klíč" };
  if (!voiceId) return { error: "Chybí ID hlasu" };
  const r = await fetch("https://api.elevenlabs.io/v1/text-to-speech/" + encodeURIComponent(voiceId), {
    method: "POST",
    headers: { "xi-api-key": apiKey, "Content-Type": "application/json", "Accept": "audio/mpeg" },
    body: JSON.stringify({ text, model_id: modelId || "eleven_multilingual_v2",
      voice_settings: { stability: 0.45, similarity_boost: 0.8, use_speaker_boost: true } })
  });
  if (!r.ok) { let t=""; try{t=await r.text();}catch(e){} return { error: "ElevenLabs " + r.status + " " + t.slice(0,160) }; }
  return { audio: bufToB64(await r.arrayBuffer()) };
}
async function elevenVoices(apiKey) {
  if (!apiKey) return { error: "Chybí API klíč" };
  const r = await fetch("https://api.elevenlabs.io/v1/voices", { headers: { "xi-api-key": apiKey } });
  if (!r.ok) return { error: "Voices " + r.status };
  const d = await r.json();
  return { voices: (d.voices || []).map((v) => ({ id: v.voice_id, name: v.name })) };
}

// ---- Azure (Microsoft Natural voices: cs-CZ-VlastaNeural / AntoninNeural) ----
async function azureTTS({ key, region, voice, text, rate }) {
  if (!key || !region) return { error: "Chybí Azure klíč nebo region" };
  const v = voice || "cs-CZ-VlastaNeural";
  const lang = v.slice(0, 5) || "cs-CZ";
  const pct = rate ? Math.round((Number(rate) - 1) * 100) : 0;
  const prosody = pct ? ` rate='${pct > 0 ? "+" : ""}${pct}%'` : "";
  const ssml = `<speak version='1.0' xml:lang='${lang}'><voice name='${v}'><prosody${prosody}>${escapeXml(text)}</prosody></voice></speak>`;
  const r = await fetch(`https://${region}.tts.speech.microsoft.com/cognitiveservices/v1`, {
    method: "POST",
    headers: {
      "Ocp-Apim-Subscription-Key": key,
      "Content-Type": "application/ssml+xml",
      "X-Microsoft-OutputFormat": "audio-24khz-48kbitrate-mono-mp3",
      "User-Agent": "yt-dabing-cz"
    },
    body: ssml
  });
  if (!r.ok) { let t=""; try{t=await r.text();}catch(e){} return { error: "Azure " + r.status + " " + t.slice(0,160) }; }
  return { audio: bufToB64(await r.arrayBuffer()) };
}

/* ---- Gemini Live (audio->audio) ---- */
let geminiTabId = null;

chrome.runtime.onMessage.addListener((msg, sender, send) => {
  if (!msg) return;
  if (msg.target === "offscreen") return;           // patří offscreenu, ignoruj
  if (msg.type === "GEMINI_START") { startGemini(msg, sender).then(send).catch((e) => send({ error: String(e && e.message || e) })); return true; }
  if (msg.type === "GEMINI_STOP") { stopGemini().then(() => send({ ok: true })); return true; }
  if (msg.type === "GEMINI_STATUS") {            // od offscreenu -> přepošli do karty
    if (geminiTabId) { try { chrome.tabs.sendMessage(geminiTabId, { type: "DABING_GEMINI_STATUS", kind: msg.kind, text: msg.text }); } catch (e) {} }
    return;
  }
});

async function hasOffscreen() {
  try {
    const c = await chrome.runtime.getContexts({ contextTypes: ["OFFSCREEN_DOCUMENT"] });
    return c && c.length > 0;
  } catch (e) {
    try { return await chrome.offscreen.hasDocument(); } catch (e2) { return false; }
  }
}
async function ensureOffscreen() {
  if (await hasOffscreen()) return;
  await chrome.offscreen.createDocument({
    url: "src/offscreen.html",
    reasons: ["USER_MEDIA"],
    justification: "Překlad zvuku videa v reálném čase přes Gemini Live API."
  });
}
function getStreamId(tabId) {
  return new Promise((res, rej) => {
    chrome.tabCapture.getMediaStreamId({ targetTabId: tabId }, (id) => {
      if (chrome.runtime.lastError) rej(new Error(chrome.runtime.lastError.message));
      else res(id);
    });
  });
}
async function startGemini(msg, sender) {
  const tabId = sender && sender.tab && sender.tab.id;
  if (!tabId) return { error: "Není ID karty" };
  if (!msg.apiKey) return { error: "Chybí Gemini API klíč" };
  await stopGemini();                                  // pošli stop -> offscreen uloží soubory
  await new Promise((r) => setTimeout(r, 400));
  try { if (await hasOffscreen()) await chrome.offscreen.closeDocument(); } catch (e) {}  // čistý reset capture
  await new Promise((r) => setTimeout(r, 350));
  await ensureOffscreen();
  let streamId;
  try {
    streamId = await getStreamId(tabId);
  } catch (e) {
    try { if (await hasOffscreen()) await chrome.offscreen.closeDocument(); } catch (e2) {}
    await new Promise((r) => setTimeout(r, 700));
    await ensureOffscreen();
    streamId = await getStreamId(tabId);
  }
  geminiTabId = tabId;
  chrome.runtime.sendMessage({ target: "offscreen", type: "GEMINI_OFFSCREEN_START", streamId, apiKey: msg.apiKey, lang: msg.lang, recordVideo: !!msg.recordVideo, recordAudio: !!msg.recordAudio, title: msg.title || "" });
  return { ok: true };
}
async function stopGemini() {
  // offscreen NEcháme žít, aby se stihla uložit nahrávka; dokument zavřeme až při dalším startu
  try { chrome.runtime.sendMessage({ target: "offscreen", type: "GEMINI_OFFSCREEN_STOP" }); } catch (e) {}
  geminiTabId = null;
}
