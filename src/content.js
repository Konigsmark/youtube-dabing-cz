/* YouTube Dabing CZ – content script (čtení zobrazených titulků + TTS) */
(() => {
  "use strict";

  const DEFAULTS = {
    enabled: false, targetLang: "cs", rate: 1.1, pitch: 1.0,
    volume: 1.0, voiceURI: "", muteOriginal: true
  };
  const LANG_BCP = { cs:"cs-CZ", en:"en-US", de:"de-DE", sk:"sk-SK", pl:"pl-PL", es:"es-ES" };

  let settings = { ...DEFAULTS };
  let active = false;
  let video = null, prevMuted = null, injected = false;
  let capObserver = null, lastSpoken = "", debounce = null, noCapTimer = null;

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
  function onCaptionChange() {
    if (!active) return;
    clearTimeout(debounce);
    debounce = setTimeout(() => {
      const t = readCaptionText();
      if (!t) return;
      // mluv jen ustálenou novou větu (ne průběžné dopisování)
      if (t !== lastSpoken && !(lastSpoken && lastSpoken.startsWith(t))) {
        lastSpoken = t;
        if (noCapTimer) { clearTimeout(noCapTimer); noCapTimer = null; }
        speak(t);
      }
    }, 320);
  }
  function startCaptionWatch() {
    stopCaptionWatch();
    const target = document.querySelector(".html5-video-player") || document.body;
    capObserver = new MutationObserver(onCaptionChange);
    capObserver.observe(target, { childList: true, subtree: true, characterData: true });
  }
  function stopCaptionWatch() {
    if (capObserver) { capObserver.disconnect(); capObserver = null; }
    clearTimeout(debounce);
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
  function speak(text) {
    if (!window.speechSynthesis) return;
    try { window.speechSynthesis.cancel(); } catch (e) {}
    const u = new SpeechSynthesisUtterance(text);
    const v = pickVoice();
    if (v) u.voice = v;
    u.lang = v ? v.lang : bcp(settings.targetLang);
    u.rate = Number(settings.rate) || 1.1;
    u.pitch = Number(settings.pitch) || 1.0;
    u.volume = Number(settings.volume) || 1.0;
    window.speechSynthesis.speak(u);
  }

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
  function onSeek() { lastSpoken = ""; try { window.speechSynthesis.cancel(); } catch (e) {} }
  function onPause() { if (active && window.speechSynthesis) window.speechSynthesis.pause(); }
  function onPlay() { if (active && window.speechSynthesis) window.speechSynthesis.resume(); }

  // ---- zapnout / vypnout ----
  function enable() {
    attachVideo();
    requestEnable();                 // pokus zapnout titulky + překlad v přehrávači
    lastSpoken = "";
    startCaptionWatch();
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
    clearTimeout(noCapTimer); noCapTimer = null;
    try { window.speechSynthesis && window.speechSynthesis.cancel(); } catch (e) {}
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
  function updateButton() {
    const btn = document.getElementById(BTN_ID); if (!btn) return;
    btn.classList.toggle("dabing-cz-active", active);
    const badge = btn.querySelector(".dabing-cz-badge");
    if (badge) badge.textContent = (settings.targetLang || "").toUpperCase();
    const n = (settings.targetLang || "").toUpperCase();
    btn.title = active ? `Dabing (${n}) zapnut – kliknutím vypnete` : `Spustit dabing (${n})`;
  }
  function toast(text) {
    let el = document.getElementById("dabing-cz-toast");
    if (!el) { el = document.createElement("div"); el.id = "dabing-cz-toast"; document.body.appendChild(el); }
    el.textContent = text; el.classList.add("show");
    clearTimeout(el._t); el._t = setTimeout(() => el.classList.remove("show"), 6000);
  }

  function onNavigate() { lastSpoken = ""; attachVideo(); ensureButton(); if (active) requestEnable(); }
  document.addEventListener("yt-navigate-finish", onNavigate);
  window.addEventListener("yt-page-data-updated", onNavigate);
  new MutationObserver(() => ensureButton()).observe(document.body, { childList: true, subtree: true });

  if (window.speechSynthesis) { window.speechSynthesis.onvoiceschanged = () => {}; getVoices(); }

  loadSettings().then(() => {
    injectPageScript(); attachVideo(); ensureButton();
    if (settings.enabled && getVideoId()) setTimeout(() => enable(), 1800);
  });
})();
