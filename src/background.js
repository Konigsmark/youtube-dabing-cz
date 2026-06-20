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
