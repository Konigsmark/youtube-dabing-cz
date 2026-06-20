const DEFAULTS = {
  enabled:false, targetLang:"cs", rate:1.1, pitch:1.0, volume:1.0,
  voiceURI:"", muteOriginal:true,
  ttsEngine:"builtin",
  elevenKey:"", elevenVoiceId:"21m00Tcm4TlvDq8ikWAM", elevenModel:"eleven_multilingual_v2",
  azureKey:"", azureRegion:"", azureVoice:"cs-CZ-VlastaNeural"
};
const $ = (id) => document.getElementById(id);

function fillVoices(selected) {
  const sel = $("voice");
  const voices = (window.speechSynthesis && speechSynthesis.getVoices()) || [];
  sel.innerHTML = '<option value="">Automaticky podle jazyka</option>';
  for (const v of voices) {
    const o = document.createElement("option");
    o.value = v.voiceURI; o.textContent = `${v.name} (${v.lang})`;
    if (v.voiceURI === selected) o.selected = true;
    sel.appendChild(o);
  }
}
function toggleBoxes() {
  const e = $("engine").value;
  $("builtinBox").style.display = e === "builtin" ? "" : "none";
  $("azureBox").style.display = e === "azure" ? "" : "none";
  $("elevenBox").style.display = e === "elevenlabs" ? "" : "none";
}
function flash(){ const s=$("saved"); s.classList.add("show"); clearTimeout(s._t); s._t=setTimeout(()=>s.classList.remove("show"),1200); }

function save() {
  chrome.storage.sync.set({
    targetLang: $("lang").value,
    voiceURI: $("voice").value,
    rate:+$("rate").value, pitch:+$("pitch").value, volume:+$("volume").value,
    muteOriginal:$("mute").checked, enabled:$("enabled").checked,
    ttsEngine:$("engine").value,
    elevenKey:$("elevenKey").value.trim(),
    elevenVoiceId:$("elevenVoice").value || DEFAULTS.elevenVoiceId,
    elevenModel:$("elevenModel").value,
    azureKey:$("azureKey").value.trim(),
    azureRegion:$("azureRegion").value.trim().toLowerCase(),
    azureVoice:$("azureVoice").value
  }, flash);
}

function loadElevenVoices(selected) {
  const key=$("elevenKey").value.trim(), msg=$("voiceMsg");
  if(!key){ msg.textContent="Nejdřív vlož API klíč."; return; }
  msg.textContent="Načítám…";
  chrome.runtime.sendMessage({type:"ELEVEN_VOICES", apiKey:key}, (resp)=>{
    if(chrome.runtime.lastError||!resp||resp.error){
      msg.textContent="Chyba: "+((resp&&resp.error)||(chrome.runtime.lastError&&chrome.runtime.lastError.message)||"neznámá"); return;
    }
    const sel=$("elevenVoice"); sel.innerHTML="";
    for(const v of resp.voices){ const o=document.createElement("option"); o.value=v.id; o.textContent=v.name; if(v.id===selected)o.selected=true; sel.appendChild(o); }
    msg.textContent=`Načteno ${resp.voices.length} hlasů.`; save();
  });
}

async function init() {
  const s = await chrome.storage.sync.get(DEFAULTS);
  $("lang").value=s.targetLang;
  $("rate").value=s.rate; $("rateVal").textContent=(+s.rate).toFixed(1)+"×";
  $("pitch").value=s.pitch; $("pitchVal").textContent=(+s.pitch).toFixed(1);
  $("volume").value=s.volume; $("volVal").textContent=Math.round(s.volume*100)+"%";
  $("mute").checked=s.muteOriginal; $("enabled").checked=s.enabled;
  $("engine").value=s.ttsEngine;
  $("elevenKey").value=s.elevenKey; $("elevenModel").value=s.elevenModel;
  $("azureKey").value=s.azureKey; $("azureRegion").value=s.azureRegion; $("azureVoice").value=s.azureVoice;
  fillVoices(s.voiceURI);
  if(window.speechSynthesis) speechSynthesis.onvoiceschanged=()=>fillVoices(s.voiceURI);
  $("elevenVoice").innerHTML=`<option value="${s.elevenVoiceId}">${s.elevenVoiceId} (uložený)</option>`;
  toggleBoxes();

  for(const id of ["lang","voice","mute","enabled","engine","elevenModel","elevenVoice","azureVoice"]) $(id).addEventListener("change", save);
  $("engine").addEventListener("change", toggleBoxes);
  for(const id of ["elevenKey","azureKey","azureRegion"]) $(id).addEventListener("change", save);
  $("loadVoices").addEventListener("click", ()=>loadElevenVoices(s.elevenVoiceId));
  $("rate").addEventListener("input", ()=>{ $("rateVal").textContent=(+$("rate").value).toFixed(1)+"×"; save(); });
  $("pitch").addEventListener("input", ()=>{ $("pitchVal").textContent=(+$("pitch").value).toFixed(1); save(); });
  $("volume").addEventListener("input", ()=>{ $("volVal").textContent=Math.round($("volume").value*100)+"%"; save(); });
}
init();
