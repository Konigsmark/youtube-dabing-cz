/* YouTube Dabing CZ – content script */
(() => {
  "use strict";

  const DEFAULTS = {
    enabled: false, targetLang: "cs", rate: 1.1, pitch: 1.0,
    volume: 1.0, voiceURI: "", muteOriginal: true
  };
  const LANG_BCP = { cs:"cs-CZ", en:"en-US", de:"de-DE", sk:"sk-SK", pl:"pl-PL", es:"es-ES" };

  let settings = { ...DEFAULTS };
  let active = false, segments = [], segIndex = 0;
  let currentVideoId = null, video = null, prevMuted = null, loading = false;
  let injected = false;

  // ---------- nastavení ----------
  function loadSettings() {
    return new Promise((resolve) => {
      try { chrome.storage.sync.get(DEFAULTS, (s) => { settings = { ...DEFAULTS, ...s }; resolve(); }); }
      catch (e) { resolve(); }
    });
  }
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "sync") return;
    for (const k of Object.keys(changes)) settings[k] = changes[k].newValue;
    if (active && changes.targetLang) {
      segments = [];
      ensureSegments().then(() => { segIndex = nearestIndex(video ? video.currentTime : 0); }).catch(()=>{});
    }
    updateButton();
  });
  chrome.runtime.onMessage.addListener((msg, _s, sendResponse) => {
    if (msg && msg.type === "DABING_TOGGLE") { toggle().then(() => sendResponse({ active })); return true; }
    if (msg && msg.type === "DABING_STATUS") { sendResponse({ active, videoId: getVideoId() }); }
  });

  function getVideoId() {
    const u = new URL(location.href);
    if (u.pathname === "/watch") return u.searchParams.get("v");
    const m = location.pathname.match(/\/(?:shorts|embed)\/([\w-]{11})/);
    return m ? m[1] : null;
  }
  function bcp(l) { return LANG_BCP[l] || l; }

  // ---------- získání titulkových tracků z přehrávače (kontext stránky) ----------
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
  function getTracksFromPage() {
    return new Promise((resolve) => {
      injectPageScript();
      const id = Math.random().toString(36).slice(2);
      let done = false;
      function h(ev) {
        if (ev.source !== window || !ev.data || ev.data.__dabing !== "res" || ev.data.id !== id) return;
        window.removeEventListener("message", h); done = true; resolve(ev.data.tracks || []);
      }
      window.addEventListener("message", h);
      // dej stránce chvíli, případně zkus víckrát
      let tries = 0;
      const ping = () => { if (done) return; window.postMessage({ __dabing: "req", id }, "*"); if (++tries < 8) setTimeout(ping, 400); };
      ping();
      setTimeout(() => { if (!done) { window.removeEventListener("message", h); resolve([]); } }, 4000);
    });
  }

  // záloha: stáhnout watch stránku a vyparsovat captionTracks
  async function getTracksViaFetch(videoId) {
    try {
      const res = await fetch(`https://www.youtube.com/watch?v=${videoId}&hl=cs`, { credentials: "include" });
      const html = await res.text();
      const i = html.indexOf("captionTracks");
      if (i === -1) return [];
      const start = html.lastIndexOf("[", html.indexOf("[", i));
      // jednodušší: vyřízneme JSON pole captionTracks regexem
      const m = html.match(/"captionTracks":(\[.*?\])\s*,\s*"audioTracks"/s) ||
                html.match(/"captionTracks":(\[.*?\])/s);
      if (!m) return [];
      const arr = JSON.parse(m[1]);
      return arr.map((t) => ({ baseUrl: t.baseUrl, languageCode: t.languageCode, kind: t.kind || "", name: "" }));
    } catch (e) { return []; }
  }

  function pickTrack(tracks) {
    if (!tracks || !tracks.length) return null;
    return tracks.find((t) => t.kind !== "asr") || tracks[0];
  }

  async function fetchSegments(track) {
    let url = track.baseUrl;
    if (settings.targetLang && track.languageCode !== settings.targetLang) {
      url += (url.includes("?") ? "&" : "?") + "tlang=" + encodeURIComponent(settings.targetLang);
    }
    url += "&fmt=json3";
    const r = await fetch(url, { credentials: "include" });
    if (!r.ok) throw new Error("FETCH_FAIL");
    const data = await r.json();
    const segs = [];
    for (const ev of (data.events || [])) {
      if (!ev.segs) continue;
      const text = ev.segs.map((s) => s.utf8 || "").join("").replace(/\s+/g, " ").trim();
      if (text) segs.push({ start: (ev.tStartMs || 0) / 1000, dur: (ev.dDurationMs || 0) / 1000, text });
    }
    return segs;
  }

  async function ensureSegments() {
    const vid = getVideoId();
    if (!vid) throw new Error("NO_VIDEO");
    if (segments.length && currentVideoId === vid) return;
    currentVideoId = vid;
    segments = [];

    let tracks = await getTracksFromPage();
    if (!tracks.length) tracks = await getTracksViaFetch(vid);
    if (!tracks.length) throw new Error("NO_CAPTIONS");

    const track = pickTrack(tracks);
    let segs = await fetchSegments(track);
    if (!segs.length) throw new Error("FETCH_FAIL");
    segments = segs;
  }

  function nearestIndex(t) { let i = 0; while (i < segments.length && segments[i].start < t - 0.05) i++; return i; }

  // ---------- TTS ----------
  function getVoices() { return window.speechSynthesis ? window.speechSynthesis.getVoices() : []; }
  function pickVoice() {
    const voices = getVoices();
    if (settings.voiceURI) { const v = voices.find((v) => v.voiceURI === settings.voiceURI); if (v) return v; }
    const target = bcp(settings.targetLang).toLowerCase();
    const l2 = settings.targetLang.toLowerCase();
    const byLang = voices.filter((v) => v.lang.toLowerCase() === target || v.lang.toLowerCase().startsWith(l2));
    // preferuj online "Google" hlas (bývá přirozenější), pak cokoli odpovídajícího
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

  // ---------- smyčka ----------
  function onTimeUpdate() {
    if (!active || !video || !segments.length) return;
    const t = video.currentTime;
    let spoke = -1;
    while (segIndex < segments.length && segments[segIndex].start <= t + 0.2) { spoke = segIndex; segIndex++; }
    if (spoke !== -1) { const s = segments[spoke]; if (t - s.start < (s.dur || 6) + 1.5) speak(s.text); }
  }
  function onSeeking() { if (!active) return; try { window.speechSynthesis.cancel(); } catch(e){} segIndex = nearestIndex(video.currentTime); }
  function onPause() { if (active && window.speechSynthesis) window.speechSynthesis.pause(); }
  function onPlay() { if (active && window.speechSynthesis) window.speechSynthesis.resume(); }

  function attachVideo() {
    const v = document.querySelector("video.html5-main-video, video.video-stream, video");
    if (v && v !== video) {
      detachVideo(); video = v;
      video.addEventListener("timeupdate", onTimeUpdate);
      video.addEventListener("seeking", onSeeking);
      video.addEventListener("pause", onPause);
      video.addEventListener("play", onPlay);
    }
    return video;
  }
  function detachVideo() {
    if (!video) return;
    video.removeEventListener("timeupdate", onTimeUpdate);
    video.removeEventListener("seeking", onSeeking);
    video.removeEventListener("pause", onPause);
    video.removeEventListener("play", onPlay);
  }

  async function enable() {
    if (loading) return;
    loading = true; updateButton("loading");
    try {
      attachVideo();
      await ensureSegments();
      segIndex = nearestIndex(video ? video.currentTime : 0);
      if (settings.muteOriginal && video) { prevMuted = video.muted; video.muted = true; }
      active = true;
    } catch (e) {
      active = false;
      const map = {
        NO_CAPTIONS: "Toto video nemá titulky – dabing nelze spustit.",
        FETCH_FAIL: "Titulky se nepodařilo načíst (YouTube je nevrátil). Zkus jiné video nebo zapni titulky (CC) ručně.",
        NO_VIDEO: "Nenašel jsem přehrávač videa."
      };
      toast(map[e && e.message] || "Nepodařilo se načíst titulky pro překlad.");
      console.warn("[Dabing CZ]", e);
    } finally { loading = false; updateButton(); }
  }
  function disable() {
    active = false;
    try { window.speechSynthesis && window.speechSynthesis.cancel(); } catch (e) {}
    if (video && prevMuted !== null) { video.muted = prevMuted; prevMuted = null; }
    updateButton();
  }
  async function toggle() { if (active) disable(); else await enable(); }

  // ---------- tlačítko ----------
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
  function updateButton(state) {
    const btn = document.getElementById(BTN_ID); if (!btn) return;
    btn.classList.toggle("dabing-cz-active", active);
    btn.classList.toggle("dabing-cz-loading", state === "loading");
    const badge = btn.querySelector(".dabing-cz-badge");
    if (badge) badge.textContent = (settings.targetLang || "").toUpperCase();
    const n = (settings.targetLang || "").toUpperCase();
    btn.title = active ? `Dabing (${n}) zapnut – kliknutím vypnete` : `Spustit dabing (${n})`;
  }
  function toast(text) {
    let el = document.getElementById("dabing-cz-toast");
    if (!el) { el = document.createElement("div"); el.id = "dabing-cz-toast"; document.body.appendChild(el); }
    el.textContent = text; el.classList.add("show");
    clearTimeout(el._t); el._t = setTimeout(() => el.classList.remove("show"), 4500);
  }

  function onNavigate() {
    const vid = getVideoId();
    if (vid !== currentVideoId) {
      const was = active; disable(); segments = []; currentVideoId = vid; attachVideo();
      if (was || settings.enabled) setTimeout(() => enable(), 1500);
    }
    ensureButton();
  }
  document.addEventListener("yt-navigate-finish", onNavigate);
  window.addEventListener("yt-page-data-updated", onNavigate);
  new MutationObserver(() => ensureButton()).observe(document.body, { childList: true, subtree: true });

  if (window.speechSynthesis) { window.speechSynthesis.onvoiceschanged = () => {}; getVoices(); }

  loadSettings().then(() => {
    attachVideo(); ensureButton();
    if (settings.enabled && getVideoId()) setTimeout(() => enable(), 1800);
  });
})();
