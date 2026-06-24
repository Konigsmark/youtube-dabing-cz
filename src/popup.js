const DEFAULTS = {
  enabled:false, targetLang:"cs", rate:1.1, pitch:1.0, volume:1.0, voiceURI:"",
  muteOriginal:true, duckVolume:0.2,
  ttsEngine:"builtin",
  elevenKey:"", elevenVoiceId:"21m00Tcm4TlvDq8ikWAM", elevenModel:"eleven_multilingual_v2",
  azureKey:"", azureRegion:"", azureVoice:"cs-CZ-VlastaNeural",
  geminiKey:"", geminiSubs:true, recordVideo:false, recordAudio:false
};
const $ = (id) => document.getElementById(id);
let isActive = false;

async function activeTab() { const [t] = await chrome.tabs.query({ active: true, currentWindow: true }); return t; }
function setBtn() { $("toggle").textContent = isActive ? "Vypnout dabing" : "Spustit dabing"; $("toggle").classList.toggle("on", isActive); }
function flash(){ const s=$("saved"); s.classList.add("show"); clearTimeout(s._t); s._t=setTimeout(()=>s.classList.remove("show"),1200); }

function toggleBoxes() {
  const e = $("engine").value;
  $("builtinBox").style.display = e === "builtin" ? "" : "none";
  $("azureBox").style.display = e === "azure" ? "" : "none";
  $("elevenBox").style.display = e === "elevenlabs" ? "" : "none";
  $("geminiBox").style.display = e === "gemini" ? "" : "none";
}
function fillVoices(sel) {
  const el = $("voice"); const voices = (window.speechSynthesis && speechSynthesis.getVoices()) || [];
  el.innerHTML = '<option value="">Automaticky</option>';
  for (const v of voices) { const o = document.createElement("option"); o.value = v.voiceURI; o.textContent = v.name + " (" + v.lang + ")"; if (v.voiceURI === sel) o.selected = true; el.appendChild(o); }
}

function save() {
  chrome.storage.sync.set({
    targetLang: $("lang").value, voiceURI: $("voice").value,
    rate:+$("rate").value, pitch:+$("pitch").value, volume:+$("volume").value,
    muteOriginal:$("mute").checked, duckVolume:+$("duck").value, enabled:$("enabled").checked,
    ttsEngine:$("engine").value,
    elevenKey:$("elevenKey").value.trim(), elevenVoiceId:$("elevenVoice").value || DEFAULTS.elevenVoiceId, elevenModel:$("elevenModel").value,
    azureKey:$("azureKey").value.trim(), azureRegion:$("azureRegion").value.trim().toLowerCase(), azureVoice:$("azureVoice").value,
    geminiKey:$("geminiKey").value.trim(), geminiSubs:$("gsubs").checked,
    recordVideo:$("grecV").checked, recordAudio:$("grecA").checked
  }, flash);
}

function loadElevenVoices(selected) {
  const key = $("elevenKey").value.trim(), msg = $("voiceMsg");
  if (!key) { msg.textContent = "Nejdřív vlož klíč."; return; }
  msg.textContent = "Načítám…";
  chrome.runtime.sendMessage({ type: "ELEVEN_VOICES", apiKey: key }, (resp) => {
    if (chrome.runtime.lastError || !resp || resp.error) { msg.textContent = "Chyba: " + ((resp && resp.error) || "neznámá"); return; }
    const el = $("elevenVoice"); el.innerHTML = "";
    for (const v of resp.voices) { const o = document.createElement("option"); o.value = v.id; o.textContent = v.name; if (v.id === selected) o.selected = true; el.appendChild(o); }
    msg.textContent = "Načteno " + resp.voices.length + " hlasů."; save();
  });
}

async function init() {
  const s = await chrome.storage.sync.get(DEFAULTS);
  $("lang").value = s.targetLang;
  $("rate").value = s.rate; $("rateVal").textContent = (+s.rate).toFixed(1) + "×";
  $("pitch").value = s.pitch; $("pitchVal").textContent = (+s.pitch).toFixed(1);
  $("volume").value = s.volume; $("volVal").textContent = Math.round(s.volume*100) + "%";
  $("duck").value = s.duckVolume; $("duckVal").textContent = Math.round(s.duckVolume*100) + "%";
  $("mute").checked = s.muteOriginal; $("enabled").checked = s.enabled;
  $("engine").value = s.ttsEngine;
  $("elevenKey").value = s.elevenKey; $("elevenModel").value = s.elevenModel;
  $("azureKey").value = s.azureKey; $("azureRegion").value = s.azureRegion; $("azureVoice").value = s.azureVoice;
  $("geminiKey").value = s.geminiKey; $("gsubs").checked = s.geminiSubs;
  $("grecV").checked = s.recordVideo; $("grecA").checked = s.recordAudio;
  $("elevenVoice").innerHTML = '<option value="' + s.elevenVoiceId + '">' + s.elevenVoiceId + ' (uložený)</option>';
  fillVoices(s.voiceURI);
  if (window.speechSynthesis) speechSynthesis.onvoiceschanged = () => fillVoices(s.voiceURI);
  toggleBoxes();

  // přepínání pohledů
  $("more").addEventListener("click", () => { $("viewBasic").style.display = "none"; $("viewAdv").style.display = ""; });
  $("back").addEventListener("click", () => { $("viewAdv").style.display = "none"; $("viewBasic").style.display = ""; });

  // ukládání
  for (const id of ["lang","voice","mute","enabled","engine","elevenModel","elevenVoice","azureVoice","gsubs","grecV","grecA"]) $(id).addEventListener("change", save);
  for (const id of ["elevenKey","azureKey","azureRegion","geminiKey"]) $(id).addEventListener("change", save);
  $("engine").addEventListener("change", toggleBoxes);
  $("loadVoices").addEventListener("click", () => loadElevenVoices(s.elevenVoiceId));
  $("rate").addEventListener("input", () => { $("rateVal").textContent=(+$("rate").value).toFixed(1)+"×"; save(); });
  $("pitch").addEventListener("input", () => { $("pitchVal").textContent=(+$("pitch").value).toFixed(1); save(); });
  $("volume").addEventListener("input", () => { $("volVal").textContent=Math.round($("volume").value*100)+"%"; save(); });
  $("duck").addEventListener("input", () => { $("duckVal").textContent=Math.round($("duck").value*100)+"%"; save(); });

  // stav dabingu
  const tab = await activeTab();
  if (!tab || !/^https:\/\/www\.youtube\.com\//.test(tab.url || "")) { $("status").textContent = "Otevři video na youtube.com."; }
  else { try { const r = await chrome.tabs.sendMessage(tab.id, { type: "DABING_STATUS" }); isActive = !!(r && r.active); } catch (e) { $("status").textContent = "Načti (F5) stránku videa."; } }
  setBtn();
  $("toggle").addEventListener("click", async () => {
    const t = await activeTab();
    try { const r = await chrome.tabs.sendMessage(t.id, { type: "DABING_TOGGLE" }); isActive = !!(r && r.active); setBtn(); $("status").textContent = isActive ? "Dabing běží." : ""; }
    catch (e) { $("status").textContent = "Načti (F5) stránku a zkus znovu."; }
  });
}
init();
