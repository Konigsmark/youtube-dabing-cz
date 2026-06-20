const DEFAULTS = {
  enabled:false, targetLang:"cs", rate:1.1, pitch:1.0,
  volume:1.0, voiceURI:"", muteOriginal:true
};
const $ = (id) => document.getElementById(id);

function fillVoices(selected) {
  const sel = $("voice");
  const voices = (window.speechSynthesis && speechSynthesis.getVoices()) || [];
  sel.innerHTML = '<option value="">Automaticky podle jazyka</option>';
  for (const v of voices) {
    const o = document.createElement("option");
    o.value = v.voiceURI;
    o.textContent = `${v.name} (${v.lang})`;
    if (v.voiceURI === selected) o.selected = true;
    sel.appendChild(o);
  }
}

function flash() {
  const s = $("saved");
  s.classList.add("show");
  clearTimeout(s._t);
  s._t = setTimeout(() => s.classList.remove("show"), 1200);
}

function save() {
  chrome.storage.sync.set({
    targetLang: $("lang").value,
    voiceURI: $("voice").value,
    rate: +$("rate").value,
    pitch: +$("pitch").value,
    volume: +$("volume").value,
    muteOriginal: $("mute").checked,
    enabled: $("enabled").checked
  }, flash);
}

async function init() {
  const s = await chrome.storage.sync.get(DEFAULTS);
  $("lang").value = s.targetLang;
  $("rate").value = s.rate; $("rateVal").textContent = (+s.rate).toFixed(1) + "×";
  $("pitch").value = s.pitch; $("pitchVal").textContent = (+s.pitch).toFixed(1);
  $("volume").value = s.volume; $("volVal").textContent = Math.round(s.volume*100) + "%";
  $("mute").checked = s.muteOriginal;
  $("enabled").checked = s.enabled;
  fillVoices(s.voiceURI);
  if (window.speechSynthesis) speechSynthesis.onvoiceschanged = () => fillVoices(s.voiceURI);

  for (const id of ["lang","voice","mute","enabled"]) $(id).addEventListener("change", save);
  $("rate").addEventListener("input", () => { $("rateVal").textContent=(+$("rate").value).toFixed(1)+"×"; save(); });
  $("pitch").addEventListener("input", () => { $("pitchVal").textContent=(+$("pitch").value).toFixed(1); save(); });
  $("volume").addEventListener("input", () => { $("volVal").textContent=Math.round($("volume").value*100)+"%"; save(); });
}
init();
