/* YouTube Dabing CZ – content script
 * Čte titulky zobrazené v přehrávači a předčítá je nahlas (vestavěný / Azure / ElevenLabs).
 * Fronta zajišťuje, že se přečte KAŽDÁ věta (nic se nezahazuje).
 */
(() => {
  "use strict";

  const DEFAULTS = {
    enabled: false, targetLang: "cs", rate: 1.1, pitch: 1.0,
    volume: 1.0, voiceURI: "", muteOriginal: true, duckVolume: 0.2,
    ttsEngine: "builtin",
    elevenKey: "", elevenVoiceId: "21m00Tcm4TlvDq8ikWAM", elevenModel: "eleven_multilingual_v2",
    azureKey: "", azureRegion: "", azureVoice: "cs-CZ-VlastaNeural",
    geminiKey: "", geminiSubs: true, recordVideo: false, recordAudio: false
  };
  const LANG_BCP = { cs: "cs-CZ", en: "en-US", de: "de-DE", sk: "sk-SK", pl: "pl-PL", es: "es-ES" };

  let settings = { ...DEFAULTS };
  let active = false;
  let video = null, prevVolume = null, injected = false;
  let capObserver = null, capTimer = null, flushTimer = null, spokenWords = [], pending = "", noCapTimer = null, keepAlive = null;

  const queue = [];
  let playing = false, curAudio = null, warned = false;
  let ttsCtx = null, ttsComp = null, ttsGain = null;
  let gTop = "", gBottom = "", gBuf = "", gTimer = null, gClear = null;

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
    if (msg && msg.type === "DABING_GEMINI_STATUS") {
      if (msg.kind === "err") toast("Gemini: " + msg.text);
      else if (msg.kind === "info") toast("Gemini: " + msg.text);
      else if (msg.kind === "transcript") onGeminiTranscript(msg.text);
    }
  });

  function getVideoId() {
    const u = new URL(location.href);
    if (u.pathname === "/watch") return u.searchParams.get("v");
    const m = location.pathname.match(/\/(?:shorts|embed)\/([\w-]{11})/);
    return m ? m[1] : null;
  }
  const bcp = (l) => LANG_BCP[l] || l;
  function getVideoTitle() {
    const el = document.querySelector("h1.ytd-watch-metadata yt-formatted-string, h1.ytd-watch-metadata, ytd-watch-metadata #title");
    let t = el && el.textContent && el.textContent.trim();
    if (!t) t = (document.title || "").replace(/^\(\d+\)\s*/, "").replace(/\s*-\s*YouTube\s*$/, "").trim();
    return t || "youtube-dabing";
  }

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
  function requestVolume(pct) {
    injectPageScript();
    window.postMessage({ __dabing: "vol", id: Math.random().toString(36).slice(2), value: pct }, "*");
  }
  function duckLevel() { return Math.max(0, Math.min(1, Number(settings.duckVolume))); }

  function readCaptionText() {
    const segs = document.querySelectorAll(".ytp-caption-segment");
    if (!segs.length) return "";
    return Array.from(segs).map((s) => s.textContent).join(" ").replace(/\s+/g, " ").trim();
  }
  function resetCaptions() {
    spokenWords = []; pending = "";
    clearTimeout(flushTimer); clearTimeout(capTimer);
  }
  function flushPending() {
    const p = pending.trim(); pending = "";
    if (p) enqueue(p);
  }
  // ze zobrazených (rolujících) titulků vyber jen NOVÁ slova podle překryvu
  function processCaptions() {
    if (!active) return;
    let t = readCaptionText()
      .replace(/\[[^\]]*\]/g, " ").replace(/\([^)]*\)/g, " ")
      .replace(/\s+/g, " ").trim();
    if (!t) return;
    if (noCapTimer) { clearTimeout(noCapTimer); noCapTimer = null; }
    const cur = t.split(" ").filter(Boolean);
    let k = 0;
    const maxK = Math.min(spokenWords.length, cur.length);
    for (let n = maxK; n >= 1; n--) {
      if (spokenWords.slice(-n).join(" ") === cur.slice(0, n).join(" ")) { k = n; break; }
    }
    const nw = cur.slice(k);
    if (!nw.length) return;
    spokenWords.push(...nw);
    if (spokenWords.length > 60) spokenWords = spokenWords.slice(-60);
    pending = pending ? pending + " " + nw.join(" ") : nw.join(" ");
    // vyřízni hotové věty (končící . ! ? …)
    let m;
    while ((m = pending.match(/^([\s\S]*?[.!?…])\s+([\s\S]*)$/))) { enqueue(m[1].trim()); pending = m[2]; }
    if (pending.length > 180) flushPending();
    clearTimeout(flushTimer);
    flushTimer = setTimeout(flushPending, 900);   // po pauze dořekni zbytek
  }
  function onCaptionChange() {
    if (!active) return;
    clearTimeout(capTimer);
    capTimer = setTimeout(processCaptions, 150);
  }
  function startCaptionWatch() {
    stopCaptionWatch();
    const target = document.querySelector(".html5-video-player") || document.body;
    capObserver = new MutationObserver(onCaptionChange);
    capObserver.observe(target, { childList: true, subtree: true, characterData: true });
  }
  function stopCaptionWatch() {
    if (capObserver) { capObserver.disconnect(); capObserver = null; }
    clearTimeout(capTimer); clearTimeout(flushTimer);
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
  function ensureTtsCtx() {
    if (ttsCtx) return;
    try {
      ttsCtx = new (window.AudioContext || window.webkitAudioContext)();
      ttsComp = ttsCtx.createDynamicsCompressor();           // vyrovná kolísání hlasitosti
      ttsComp.threshold.value = -18; ttsComp.knee.value = 20; ttsComp.ratio.value = 4;
      ttsComp.attack.value = 0.004; ttsComp.release.value = 0.25;
      ttsGain = ttsCtx.createGain();
      ttsComp.connect(ttsGain); ttsGain.connect(ttsCtx.destination);
    } catch (e) { ttsCtx = null; }
  }
  async function playBase64(b64, onend) {
    try {
      const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      const url = URL.createObjectURL(new Blob([bytes], { type: "audio/mpeg" }));
      stopAudio();
      const audio = new Audio(url);
      const rate = Math.min(2, Math.max(0.5, Number(settings.rate) || 1));
      audio.playbackRate = rate;
      try { audio.preservesPitch = true; audio.mozPreservesPitch = true; audio.webkitPreservesPitch = true; } catch (e) {}
      ensureTtsCtx();
      const vol = Number(settings.volume) || 1.0;
      if (ttsCtx) {
        try {
          if (ttsCtx.state === "suspended") ttsCtx.resume();
          // změř hlasitost klipu (RMS) a dorovnej na cílovou úroveň
          let clipGain = 1;
          try {
            const buf = await ttsCtx.decodeAudioData(bytes.buffer.slice(0));
            const ch = buf.getChannelData(0), N = ch.length, step = Math.max(1, Math.floor(N / 20000));
            let sum = 0, cnt = 0;
            for (let i = 0; i < N; i += step) { sum += ch[i] * ch[i]; cnt++; }
            const rms = Math.sqrt(sum / Math.max(1, cnt));
            if (rms > 0.0005) clipGain = Math.min(3.5, Math.max(0.35, 0.12 / rms));
          } catch (e) {}
          if (!active) { try { URL.revokeObjectURL(url); } catch (e) {} if (onend) onend(); return; }
          ttsGain.gain.value = vol * clipGain;
          const node = ttsCtx.createMediaElementSource(audio);
          node.connect(ttsComp);
        } catch (e) { audio.volume = vol; }
      } else {
        audio.volume = vol;
      }
      const fin = () => { try { URL.revokeObjectURL(url); } catch (e) {} if (onend) onend(); };
      audio.onended = fin; audio.onerror = fin;
      curAudio = audio;
      audio.play().catch(() => fin());
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
      if (active && settings.muteOriginal) {
        const vv = document.querySelector("video.html5-main-video, video.video-stream, video");
        const d = duckLevel();
        if (vv && vv.volume > d + 0.02) { try { vv.volume = d; } catch (e) {} requestVolume(Math.round(d * 100)); }
      }
    }, 2500);
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
  function onSeek() { if (!active) return; resetCaptions(); clearSpeech(); }
  function onPause() { if (active && window.speechSynthesis) window.speechSynthesis.pause(); }
  function onPlay() { if (active && window.speechSynthesis) window.speechSynthesis.resume(); }

  function enableGemini() {
    active = true; updateButtons();
    chrome.runtime.sendMessage({ type: "GEMINI_START", apiKey: settings.geminiKey, lang: settings.targetLang, recordVideo: settings.recordVideo, recordAudio: settings.recordAudio, title: getVideoTitle() }, (resp) => {
      if (chrome.runtime.lastError || !resp || resp.error) {
        active = false; updateButtons();
        const err = (resp && resp.error) || (chrome.runtime.lastError && chrome.runtime.lastError.message) || "chyba";
        if (/invoked|activeTab/i.test(err))
          toast("Gemini: klikni nejdřív na IKONU rozšíření v liště Chromu (to udělí právo zachytit kartu), pak spusť DAB.");
        else
          toast("Gemini Live nelze spustit: " + err);
      } else {
        toast("Gemini Live dabing běží (audio→audio).");
      }
    });
  }
  function enable() {
    if (settings.ttsEngine === "gemini") { if (!settings.geminiKey) { toast("Zadej Gemini API klíč v nastavení."); return; } enableGemini(); return; }
    attachVideo();
    resetCaptions(); warned = false; queue.length = 0;
    startCaptionWatch();
    startKeepAlive();
    if (settings.muteOriginal && video) {
      prevVolume = video.volume;
      const d = duckLevel();
      try { video.volume = d; } catch (e) {}
      requestVolume(Math.round(d * 100));
    }
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
    try { chrome.runtime.sendMessage({ type: "GEMINI_STOP" }); } catch (e) {}
    clearSub();
    stopCaptionWatch(); stopKeepAlive();
    clearTimeout(noCapTimer); noCapTimer = null;
    resetCaptions();
    clearSpeech();
    if (video && prevVolume !== null) {
      try { video.volume = prevVolume; } catch (e) {}
      requestVolume(Math.round(prevVolume * 100));
      prevVolume = null;
    }
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
    if (cc && cc.parentElement) cc.parentElement.insertBefore(btn, cc);
    else { const left = controls.querySelector(".ytp-right-controls-left") || controls; left.insertBefore(btn, left.firstChild); }
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
  function ensureUI() {
    try { ensurePlayerButton(); } catch (e) {}
    try { ensureActionButton(); } catch (e) {}
    try { ensureFloatButton(); } catch (e) {}
  }

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

  function renderSub() {
    const host = document.querySelector(".html5-video-player") || document.body;
    let el = document.getElementById("dabing-cz-subs");
    if (!gTop && !gBottom) { if (el) el.remove(); return; }
    if (!el) { el = document.createElement("div"); el.id = "dabing-cz-subs"; }
    if (el.parentElement !== host) host.appendChild(el);
    // jen nová věta + změř počet řádků; nic se neořezává (žádné "…")
    el.innerHTML = "";
    el.appendChild(document.createTextNode(gTop || ""));
    const lh = parseFloat(getComputedStyle(el).lineHeight) || 38;
    const topLines = Math.round(el.offsetHeight / lh);
    // předchozí větu přidej jen když se nová vejde na jeden řádek
    if (gBottom && topLines <= 1) {
      el.appendChild(document.createElement("br"));
      el.appendChild(document.createTextNode(gBottom));
    }
  }
  function pushLine(str) {
    str = (str || "").trim(); if (!str) return;
    gBottom = gTop; gTop = str;   // nová věta nahoru, předchozí dolů
    renderSub();
  }
  function onGeminiTranscript(t) {
    if (!settings.geminiSubs || !t) return;
    gBuf += t;
    let m;
    while ((m = gBuf.match(/^([\s\S]*?[.!?…])(\s+[\s\S]*|)$/))) {
      pushLine(m[1]);
      gBuf = m[2].replace(/^\s+/, "");
      if (!gBuf) break;
    }
    clearTimeout(gTimer);
    gTimer = setTimeout(() => { if (gBuf.trim()) { pushLine(gBuf.trim()); gBuf = ""; } }, 1200);
    clearTimeout(gClear);
    gClear = setTimeout(clearSub, 9000);
  }
  function clearSub() { clearTimeout(gTimer); clearTimeout(gClear); gTop = ""; gBottom = ""; gBuf = ""; renderSub(); }
  function toast(text) {
    let el = document.getElementById("dabing-cz-toast");
    if (!el) { el = document.createElement("div"); el.id = "dabing-cz-toast"; document.body.appendChild(el); }
    el.textContent = text; el.classList.add("show");
    clearTimeout(el._t); el._t = setTimeout(() => el.classList.remove("show"), 6000);
  }

  function onNavigate() {
    resetCaptions(); attachVideo(); ensureUI();
  }
  document.addEventListener("yt-navigate-finish", onNavigate);
  window.addEventListener("yt-page-data-updated", onNavigate);
  new MutationObserver(() => ensureUI()).observe(document.body, { childList: true, subtree: true });

  if (window.speechSynthesis) { window.speechSynthesis.onvoiceschanged = () => {}; getVoices(); }

  loadSettings().then(() => {
    injectPageScript(); attachVideo(); ensureUI();
    if (settings.enabled && getVideoId()) setTimeout(() => enable(), 1800);
  });
})();
