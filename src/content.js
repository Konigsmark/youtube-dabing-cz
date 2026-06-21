/* YouTube Dabing CZ – content script
 * Čte titulky zobrazené v přehrávači a předčítá je nahlas (vestavěný / Azure / ElevenLabs).
 * Fronta zajišťuje, že se přečte KAŽDÁ věta (nic se nezahazuje).
 */
(() => {
  "use strict";

  const DEFAULTS = {
    enabled: false, targetLang: "cs", rate: 1.1, pitch: 1.0,
    volume: 1.0, voiceURI: "", muteOriginal: true,
    ttsEngine: "builtin",
    elevenKey: "", elevenVoiceId: "21m00Tcm4TlvDq8ikWAM", elevenModel: "eleven_multilingual_v2",
    azureKey: "", azureRegion: "", azureVoice: "cs-CZ-VlastaNeural"
  };
  const LANG_BCP = { cs: "cs-CZ", en: "en-US", de: "de-DE", sk: "sk-SK", pl: "pl-PL", es: "es-ES" };

  let settings = { ...DEFAULTS };
  let active = false;
  let video = null, prevMuted = null, injected = false;
  let capObserver = null, stabTimer = null, lastEmitted = "", noCapTimer = null, keepAlive = null;

  const queue = [];
  let playing = false, curAudio = null, warned = false;

  function loadSettings() {
    return new Promise((res) => {
      try { chrome.storage.sync.get(DEFAULTS, (s) => { settings = { ...DEFAULTS, ...s }; res(); }); }
      catch (e) { res(); }
    });
  }
  chrome.storage.onChanged.addListener((c, area) => {
    if (area !== "sync") return;
    for (const k of Object.keys(c)) settings[k] = c[k].newValue;
    updateButtons();
  });
  chrome.runtime.onMessage.addListener((msg, _s, send) => {
    if (msg && msg.type === "DABING_TOGGLE") { toggle(); send({ active }); }
    if (msg && msg.type === "DABING_STATUS") send({ active, videoId: getVideoId() });
  });

  function getVideoId() {
    const u = new URL(location.href);
    if (u.pathname === "/watch") return u.searchParams.get("v");
    const m = location.pathname.match(/\/(?:shorts|embed)\/([\w-]{11})/);
    return m ? m[1] : null;
  }
  const bcp = (l) => LANG_BCP[l] || l;

  function injectPageScript() {
    if (injected) return;
    injected = true;
    try {
      const s = document.createElement("script");
      s.src = chrome.runtime.getURL("src/inject.js");
      (document.head || document.documentElement).appendChild(s);
      s.addEventListener("load", () => s.remove());
    } catch (e) { injected = false; }
  }
  function requestEnable() {
    injectPageScript();
    window.postMessage({ __dabing: "enable", id: Math.random().toString(36).slice(2), lang: settings.targetLang }, "*");
  }

  function readCaptionText() {
    const segs = document.querySelectorAll(".ytp-caption-segment");
    if (!segs.length) return "";
    return Array.from(segs).map((s) => s.textContent).join(" ").replace(/\s+/g, " ").trim();
  }
  function onCaptionChange() {
    if (!active) return;
    clearTimeout(stabTimer);
    stabTimer = setTimeout(() => {
      let t = readCaptionText();
      // odfiltruj nemluvené popisky typu [Music], (applause)
      t = t.replace(/\[[^\]]*\]/g, " ").replace(/\([^)]*\)/g, " ").replace(/\s+/g, " ").trim();
      if (!t || t === lastEmitted) return;
      // pokud nová věta jen prodlužuje rozepsanou (roluje), počkáme – přečteme ji celou až ustálenou
      const prev = lastEmitted;
      lastEmitted = t;
      if (noCapTimer) { clearTimeout(noCapTimer); noCapTimer = null; }
      // přeskoč, jde-li jen o prefix už řečené věty
      if (prev && prev.startsWith(t)) return;
      enqueue(t);
    }, 360);
  }
  function startCaptionWatch() {
    stopCaptionWatch();
    const target = document.querySelector(".html5-video-player") || document.body;
    capObserver = new MutationObserver(onCaptionChange);
    capObserver.observe(target, { childList: true, subtree: true, characterData: true });
  }
  function stopCaptionWatch() {
    if (capObserver) { capObserver.disconnect(); capObserver = null; }
    clearTimeout(stabTimer);
  }

  function isCloud() {
    return (settings.ttsEngine === "elevenlabs" && settings.elevenKey && settings.elevenVoiceId) ||
           (settings.ttsEngine === "azure" && settings.azureKey && settings.azureRegion);
  }
  function fetchCloudAudio(text) {
    return new Promise((resolve) => {
      let msg;
      if (settings.ttsEngine === "elevenlabs")
        msg = { type: "ELEVEN_TTS", apiKey: settings.elevenKey, voiceId: settings.elevenVoiceId, modelId: settings.elevenModel, text };
      else
        msg = { type: "AZURE_TTS", key: settings.azureKey, region: settings.azureRegion, voice: settings.azureVoice, text, rate: settings.rate };
      try {
        chrome.runtime.sendMessage(msg, (resp) => {
          if (chrome.runtime.lastError || !resp || resp.error || !resp.audio)
            resolve({ error: (resp && resp.error) || (chrome.runtime.lastError && chrome.runtime.lastError.message) || "chyba" });
          else resolve({ audio: resp.audio });
        });
      } catch (e) { resolve({ error: String(e) }); }
    });
  }
  function enqueue(text) {
    if (!text) return;
    queue.push({ text, audio: isCloud() ? fetchCloudAudio(text) : null });
    if (queue.length > 20) queue.shift();
    if (!playing) drain();
  }
  function drain() {
    if (playing) return;
    const item = queue.shift();
    if (!item) { playing = false; return; }
    playing = true;
    const next = () => { playing = false; if (active) drain(); };
    if (item.audio) {
      item.audio.then((r) => {
        if (!active) { playing = false; return; }
        if (r && r.audio) playBase64(r.audio, next);
        else {
          if (r && r.error && !warned) { warned = true; toast("Neuronový hlas: " + r.error + " – používám záložní hlas."); }
          speakBuiltin(item.text, next);
        }
      });
    } else {
      speakBuiltin(item.text, next);
    }
  }
  function speakBuiltin(text, onend) {
    if (!window.speechSynthesis) { onend && onend(); return; }
    const u = new SpeechSynthesisUtterance(text);
    const v = pickVoice();
    if (v) u.voice = v;
    u.lang = v ? v.lang : bcp(settings.targetLang);
    u.rate = Number(settings.rate) || 1.1;
    u.pitch = Number(settings.pitch) || 1.0;
    u.volume = Number(settings.volume) || 1.0;
    u.onend = onend; u.onerror = onend;
    try { window.speechSynthesis.speak(u); } catch (e) { onend && onend(); }
  }
  function playBase64(b64, onend) {
    try {
      const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      const url = URL.createObjectURL(new Blob([bytes], { type: "audio/mpeg" }));
      stopAudio();
      curAudio = new Audio(url);
      curAudio.volume = Number(settings.volume) || 1.0;
      const fin = () => { try { URL.revokeObjectURL(url); } catch (e) {} if (onend) onend(); };
      curAudio.onended = fin; curAudio.onerror = fin;
      curAudio.play().catch(() => fin());
    } catch (e) { onend && onend(); }
  }
  function stopAudio() { if (curAudio) { try { curAudio.pause(); } catch (e) {} curAudio = null; } }
  function clearSpeech() {
    queue.length = 0; playing = false;
    stopAudio();
    try { window.speechSynthesis && window.speechSynthesis.cancel(); } catch (e) {}
  }

  function getVoices() { return window.speechSynthesis ? window.speechSynthesis.getVoices() : []; }
  function pickVoice() {
    const voices = getVoices();
    if (settings.voiceURI) { const v = voices.find((v) => v.voiceURI === settings.voiceURI); if (v) return v; }
    const target = bcp(settings.targetLang).toLowerCase(), l2 = settings.targetLang.toLowerCase();
    const byLang = voices.filter((v) => v.lang.toLowerCase() === target || v.lang.toLowerCase().startsWith(l2));
    return byLang.find((v) => /google/i.test(v.name)) || byLang[0] || null;
  }
  function startKeepAlive() {
    stopKeepAlive();
    keepAlive = setInterval(() => {
      if (active && window.speechSynthesis && window.speechSynthesis.speaking) {
        try { window.speechSynthesis.resume(); } catch (e) {}
      }
    }, 8000);
  }
  function stopKeepAlive() { if (keepAlive) { clearInterval(keepAlive); keepAlive = null; } }

  function attachVideo() {
    const v = document.querySelector("video.html5-main-video, video.video-stream, video");
    if (v && v !== video) {
      if (video) { video.removeEventListener("seeking", onSeek); video.removeEventListener("pause", onPause); video.removeEventListener("play", onPlay); }
      video = v;
      video.addEventListener("seeking", onSeek);
      video.addEventListener("pause", onPause);
      video.addEventListener("play", onPlay);
    }
    return video;
  }
  function onSeek() { if (!active) return; lastEmitted = ""; clearSpeech(); }
  function onPause() { if (active && window.speechSynthesis) window.speechSynthesis.pause(); }
  function onPlay() { if (active && window.speechSynthesis) window.speechSynthesis.resume(); }

  function enable() {
    attachVideo();
    lastEmitted = ""; warned = false; queue.length = 0;
    startCaptionWatch();
    startKeepAlive();
    if (settings.muteOriginal && video) { prevMuted = video.muted; video.muted = true; }
    active = true;
    updateButtons();
    clearTimeout(noCapTimer);
    noCapTimer = setTimeout(() => {
      if (active && !readCaptionText() && !queue.length) {
        toast("Nevidím titulky. Zapni je tlačítkem Titulky (CC). Pro češtinu: ozubené kolečko -> Titulky -> Automaticky přeložit -> Čeština.");
      }
    }, 3000);
  }
  function disable() {
    active = false;
    stopCaptionWatch(); stopKeepAlive();
    clearTimeout(noCapTimer); noCapTimer = null;
    clearSpeech();
    if (video && prevMuted !== null) { video.muted = prevMuted; prevMuted = null; }
    updateButtons();
  }
  function toggle() { if (active) disable(); else enable(); }

  function svgIcon() {
    return `<svg height="100%" viewBox="0 0 36 36" width="100%" fill="currentColor" aria-hidden="true">
      <path d="M8 15v6h4l5 5V10l-5 5H8z"></path>
      <path d="M20 13.5c1.6 1 1.6 8 0 9" stroke="currentColor" stroke-width="1.8" fill="none" stroke-linecap="round"></path>
      <path d="M22.5 11c3 1.8 3 12.2 0 14" stroke="currentColor" stroke-width="1.8" fill="none" stroke-linecap="round"></path>
    </svg>`;
  }

  const BTN_ID = "dabing-cz-btn";
  function ensurePlayerButton() {
    const controls = document.querySelector(".ytp-right-controls");
    if (!controls || document.getElementById(BTN_ID)) return;
    const btn = document.createElement("button");
    btn.id = BTN_ID; btn.className = "ytp-button dabing-cz-button";
    btn.setAttribute("aria-label", "Dabing CZ");
    btn.innerHTML = `<span class="dabing-cz-icon">${svgIcon()}</span><span class="dabing-cz-badge">DAB</span>`;
    btn.addEventListener("click", (e) => { e.stopPropagation(); toggle(); });
    const cc = controls.querySelector(".ytp-subtitles-button");
    if (cc) controls.insertBefore(btn, cc); else controls.insertBefore(btn, controls.firstChild);
    updateButtons();
  }

  const ABTN_ID = "dabing-cz-actionbtn";
  function findActionRow() {
    const direct = Array.from(document.querySelectorAll(
      "ytd-watch-metadata #top-level-buttons-computed, #actions #top-level-buttons-computed, #menu #top-level-buttons-computed"
    )).find((r) => r && r.offsetParent !== null);
    if (direct) return direct;
    const labels = ["sdíl", "share", "notebook", "ulož", "save", "stáhn", "download"];
    const btns = document.querySelectorAll("ytd-watch-metadata button, ytd-watch-metadata a");
    for (const b of btns) {
      const al = (b.getAttribute("aria-label") || b.textContent || "").toLowerCase();
      if (labels.some((l) => al.includes(l)) && b.offsetParent !== null) {
        let p = b;
        for (let i = 0; i < 5 && p && p.parentElement; i++) {
          p = p.parentElement;
          if (p.childElementCount >= 2 && p.offsetParent !== null) return p;
        }
      }
    }
    return null;
  }
  function ensureActionButton() {
    if (document.getElementById(ABTN_ID)) return;
    const row = findActionRow();
    if (!row) return;
    const b = document.createElement("button");
    b.id = ABTN_ID; b.className = "dabing-cz-actionbtn";
    b.innerHTML = `<span class="dabing-cz-aicon">${svgIcon()}</span><span class="dabing-cz-actionlabel">DAB</span>`;
    b.addEventListener("click", (e) => { e.stopPropagation(); toggle(); });
    row.appendChild(b);
    updateButtons();
  }

  const FBTN_ID = "dabing-cz-float";
  function ensureFloatButton() {
    let f = document.getElementById(FBTN_ID);
    const haveAction = !!document.getElementById(ABTN_ID);
    if (haveAction || !getVideoId()) { if (f) f.remove(); return; }
    if (f) return;
    f = document.createElement("button");
    f.id = FBTN_ID;
    f.innerHTML = `<span class="dabing-cz-aicon">${svgIcon()}</span><span class="dabing-cz-flabel">DAB</span>`;
    f.addEventListener("click", (e) => { e.stopPropagation(); toggle(); });
    document.body.appendChild(f);
    updateButtons();
  }
  function ensureUI() { ensurePlayerButton(); ensureActionButton(); ensureFloatButton(); }

  function updateButtons() {
    const n = (settings.targetLang || "").toUpperCase();
    const tip = active ? `Dabing (${n}) zapnut – kliknutím vypnete` : `Spustit dabing (${n})`;
    const pbtn = document.getElementById(BTN_ID);
    if (pbtn) { pbtn.classList.toggle("dabing-cz-active", active); pbtn.title = tip; }
    const abtn = document.getElementById(ABTN_ID);
    if (abtn) {
      abtn.classList.toggle("dabing-cz-active", active);
      abtn.title = tip;
      const lab = abtn.querySelector(".dabing-cz-actionlabel");
      if (lab) lab.textContent = active ? "DAB ●" : "DAB";
    }
    const fbtn = document.getElementById(FBTN_ID);
    if (fbtn) {
      fbtn.classList.toggle("dabing-cz-active", active);
      fbtn.title = tip;
      const fl = fbtn.querySelector(".dabing-cz-flabel");
      if (fl) fl.textContent = active ? "DAB ●" : "DAB";
    }
  }

  function toast(text) {
    let el = document.getElementById("dabing-cz-toast");
    if (!el) { el = document.createElement("div"); el.id = "dabing-cz-toast"; document.body.appendChild(el); }
    el.textContent = text; el.classList.add("show");
    clearTimeout(el._t); el._t = setTimeout(() => el.classList.remove("show"), 6000);
  }

  function onNavigate() {
    lastEmitted = ""; attachVideo(); ensureUI();
  }
  document.addEventListener("yt-navigate-finish", onNavigate);
  window.addEventListener("yt-page-data-updated", onNavigate);
  new MutationObserver(() => ensureUI()).observe(document.body, { childList: true, subtree: true });

  if (window.speechSynthesis) { window.speechSynthesis.onvoiceschanged = () => {}; getVoices(); }

  loadSettings().then(() => {
    attachVideo(); ensureUI();
    if (settings.enabled && getVideoId()) setTimeout(() => enable(), 1800);
  });
})();
