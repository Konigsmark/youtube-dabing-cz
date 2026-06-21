/* YouTube Dabing CZ – content script (čtení zobrazených titulků + TTS) */
(() => {
  "use strict";

  const DEFAULTS = {
    enabled: false, targetLang: "cs", rate: 1.1, pitch: 1.0,
    volume: 1.0, voiceURI: "", muteOriginal: true,
    ttsEngine: "builtin",          // "builtin" | "elevenlabs" | "azure"
    elevenKey: "",
    elevenVoiceId: "21m00Tcm4TlvDq8ikWAM",
    elevenModel: "eleven_multilingual_v2",
    azureKey: "",
    azureRegion: "",
    azureVoice: "cs-CZ-VlastaNeural"
  };
  const LANG_BCP = { cs:"cs-CZ", en:"en-US", de:"de-DE", sk:"sk-SK", pl:"pl-PL", es:"es-ES" };

  let settings = { ...DEFAULTS };
  let active = false;
  let video = null, prevMuted = null, injected = false;
  let capObserver = null, lastText = "", lastEmitted = "", stabTimer = null, noCapTimer = null;
  let speaking = false, nextText = null, nextFetch = null, keepAlive = null, curAudio = null;

  function loadSettings() {
    return new Promise((res) => {
      try { chrome.storage.sync.get(DEFAULTS, (s) => { settings = { ...DEFAULTS, ...s }; res(); }); }
      catch (e) { res(); }
    });
  }
  chrome.storage.onChanged.addListener((c, area) => {
    if (area !== "sync") return;
    for (const k of Object.keys(c)) settings[k] = c[k].newValue;
    if (active && c.targetLang) requestEnable();
    updateButton();
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
  function bcp(l) { return LANG_BCP[l] || l; }

  // ---- inject page script (pro ovládání titulků v přehrávači) ----
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
    const id = Math.random().toString(36).slice(2);
    window.postMessage({ __dabing: "enable", id, lang: settings.targetLang }, "*");
  }

  // ---- čtení zobrazených titulků ----
  function readCaptionText() {
    const segs = document.querySelectorAll(".ytp-caption-segment");
    if (!segs.length) return "";
    return Array.from(segs).map((s) => s.textContent).join(" ").replace(/\s+/g, " ").trim();
  }
  // emit věty až když se text na ~520 ms ustálí (titulky se píšou po slovech)
  function onCaptionChange() {
    if (!active) return;
    const t = readCaptionText();
    if (t === lastText) return;
    lastText = t;
    clearTimeout(stabTimer);
    stabTimer = setTimeout(() => {
      const stable = readCaptionText();
      if (!stable || stable === lastEmitted) return;
      lastEmitted = stable;
      if (noCapTimer) { clearTimeout(noCapTimer); noCapTimer = null; }
      enqueue(stable);
    }, 520);
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

  // ---- TTS ----
  function getVoices() { return window.speechSynthesis ? window.speechSynthesis.getVoices() : []; }
  function pickVoice() {
    const voices = getVoices();
    if (settings.voiceURI) { const v = voices.find((v) => v.voiceURI === settings.voiceURI); if (v) return v; }
    const target = bcp(settings.targetLang).toLowerCase(), l2 = settings.targetLang.toLowerCase();
    const byLang = voices.filter((v) => v.lang.toLowerCase() === target || v.lang.toLowerCase().startsWith(l2));
    return byLang.find((v) => /google/i.test(v.name)) || byLang[0] || null;
  }
  // fronta promluv – nepřerušujeme uprostřed věty (kvůli plynulosti)
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
          if (chrome.runtime.lastError || !resp || resp.error || !resp.audio) {
            resolve({ error: (resp && resp.error) || (chrome.runtime.lastError && chrome.runtime.lastError.message) || "chyba" });
          } else resolve({ audio: resp.audio });
        });
      } catch (e) { resolve({ error: String(e) }); }
    });
  }
  // fronta s přednačítáním další věty (plynulé navázání u cloud hlasů)
  function enqueue(text) {
    if (!text) return;
    if (speaking) {
      nextText = text;
      nextFetch = isCloud() ? fetchCloudAudio(text) : null;
      return;
    }
    speaking = true;
    runOne(text, isCloud() ? fetchCloudAudio(text) : null);
  }
  async function runOne(text, fetchP) {
    const done = () => {
      if (!active) { speaking = false; return; }
      if (nextText) {
        const t = nextText, f = nextFetch; nextText = null; nextFetch = null;
        runOne(t, f || (isCloud() ? fetchCloudAudio(t) : null));
      } else speaking = false;
    };
    if (fetchP) {
      let r = null; try { r = await fetchP; } catch (e) {}
      if (!active) { speaking = false; return; }
      if (r && r.audio) { playBase64(r.audio, done); return; }
      if (r && r.error && !runOne._warned) { runOne._warned = true; toast("Neuronový hlas: " + r.error + " – používám záložní hlas."); }
      speakBuiltin(text, done);
    } else {
      speakBuiltin(text, done);
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
    nextText = null; nextFetch = null; speaking = false;
    stopAudio();
    try { window.speechSynthesis.cancel(); } catch (e) {}
  }
  // oprava chyby Chromu: dlouhé promluvy se po ~15 s sekají → pravidelný resume
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
  function onSeek() { lastText = ""; lastEmitted = ""; clearSpeech(); }
  function onPause() { if (active && window.speechSynthesis) window.speechSynthesis.pause(); }
  function onPlay() { if (active && window.speechSynthesis) window.speechSynthesis.resume(); }

  // ---- zapnout / vypnout ----
  function enable() {
    attachVideo();
    requestEnable();                 // pokus zapnout titulky + překlad v přehrávači
    lastText = ""; lastEmitted = ""; runOne._warned = false;
    startCaptionWatch();
    startKeepAlive();
    if (settings.muteOriginal && video) { prevMuted = video.muted; video.muted = true; }
    active = true;
    updateButton();
    // pokud se do 3 s neobjeví žádné titulky, upozorni
    clearTimeout(noCapTimer);
    noCapTimer = setTimeout(() => {
      if (active && !readCaptionText() && !lastSpoken) {
        toast("Nevidím titulky. Zapni je tlačítkem „Titulky (CC)\". Pro češtinu: ozubené kolečko → Titulky → Automaticky přeložit → Čeština.");
      }
    }, 3000);
  }
  function disable() {
    active = false;
    stopCaptionWatch();
    stopKeepAlive();
    clearTimeout(noCapTimer); noCapTimer = null;
    clearSpeech();
    if (video && prevMuted !== null) { video.muted = prevMuted; prevMuted = null; }
    updateButton();
  }
  function toggle() { if (active) disable(); else enable(); }

  // ---- tlačítko ----
  const BTN_ID = "dabing-cz-btn";
  function svgIcon() {
    return `<svg height="100%" viewBox="0 0 36 36" width="100%" fill="#fff">
      <path d="M8 15v6h4l5 5V10l-5 5H8z"></path>
      <path d="M20 13.5c1.6 1 1.6 8 0 9" stroke="#fff" stroke-width="1.6" fill="none" stroke-linecap="round"></path>
      <path d="M22.5 11c3 1.8 3 12.2 0 14" stroke="#fff" stroke-width="1.6" fill="none" stroke-linecap="round"></path>
    </svg>`;
  }
  function ensureButton() {
    const controls = document.querySelector(".ytp-right-controls");
    if (!controls || document.getElementById(BTN_ID)) return;
    const btn = document.createElement("button");
    btn.id = BTN_ID; btn.className = "ytp-button dabing-cz-button";
    btn.setAttribute("aria-label", "Dabing CZ");
    btn.innerHTML = `<span class="dabing-cz-icon">${svgIcon()}</span><span class="dabing-cz-badge"></span>`;
    btn.addEventListener("click", (e) => { e.stopPropagation(); toggle(); });
    const cc = controls.querySelector(".ytp-subtitles-button");
    if (cc) controls.insertBefore(btn, cc); else controls.insertBefore(btn, controls.firstChild);
    updateButton();
  }
  // ---- tlačítko v řádku akcí pod videem (vedle NotebookLM/Sdílet) ----
  const ABTN_ID = "dabing-cz-actionbtn";
  function actionIcon() {
    return `<svg viewBox="0 0 36 36" width="22" height="22" fill="currentColor" aria-hidden="true">
      <path d="M8 15v6h4l5 5V10l-5 5H8z"></path>
      <path d="M20 13.5c1.6 1 1.6 8 0 9" stroke="currentColor" stroke-width="1.8" fill="none" stroke-linecap="round"></path>
      <path d="M22.5 11c3 1.8 3 12.2 0 14" stroke="currentColor" stroke-width="1.8" fill="none" stroke-linecap="round"></path>
    </svg>`;
  }
  function ensureActionButton() {
    if (document.getElementById(ABTN_ID)) return;
    const rows = document.querySelectorAll(
      "ytd-watch-metadata #top-level-buttons-computed, " +
      "#actions #top-level-buttons-computed, #menu #top-level-buttons-computed, " +
      "ytd-watch-metadata #actions-inner"
    );
    let row = null;
    for (const r of rows) { if (r && r.offsetParent !== null) { row = r; break; } }
    if (!row) return;
    const b = document.createElement("button");
    b.id = ABTN_ID;
    b.className = "dabing-cz-actionbtn";
    b.innerHTML = `${actionIcon()}<span class="dabing-cz-actionlabel">Dabing</span>`;
    b.addEventListener("click", (e) => { e.stopPropagation(); toggle(); });
    row.appendChild(b);
    updateButton();
  }

  function updateButton() {
    const n = (settings.targetLang || "").toUpperCase();
    const tip = active ? `Dabing (${n}) zapnut – kliknutím vypnete` : `Spustit dabing (${n})`;
    const pbtn = document.getElementById(BTN_ID);
    if (pbtn) {
      pbtn.classList.toggle("dabing-cz-active", active);
      const badge = pbtn.querySelector(".dabing-cz-badge");
      if (badge) badge.textContent = n;
      pbtn.title = tip;
    }
    const abtn = document.getElementById(ABTN_ID);
    if (abtn) {
      abtn.classList.toggle("dabing-cz-active", active);
      abtn.title = tip;
      const lab = abtn.querySelector(".dabing-cz-actionlabel");
      if (lab) lab.textContent = active ? `Dabing (${n})` : "Dabing";
    }
  }
  function toast(text) {
    let el = document.getElementById("dabing-cz-toast");
    if (!el) { el = document.createElement("div"); el.id = "dabing-cz-toast"; document.body.appendChild(el); }
    el.textContent = text; el.classList.add("show");
    clearTimeout(el._t); el._t = setTimeout(() => el.classList.remove("show"), 6000);
  }

  function onNavigate() { lastText = ""; lastEmitted = ""; attachVideo(); ensureButton(); ensureActionButton(); if (active) requestEnable(); }
  document.addEventListener("yt-navigate-finish", onNavigate);
  window.addEventListener("yt-page-data-updated", onNavigate);
  new MutationObserver(() => { ensureButton(); ensureActionButton(); }).observe(document.body, { childList: true, subtree: true });

  if (window.speechSynthesis) { window.speechSynthesis.onvoiceschanged = () => {}; getVoices(); }

  loadSettings().then(() => {
    injectPageScript(); attachVideo(); ensureButton(); ensureActionButton();
    if (settings.enabled && getVideoId()) setTimeout(() => enable(), 1800);
  });
})();
