/* YouTube Dabing CZ – content script
 * Přidá tlačítko do ovládání přehrávače. Po zapnutí načte titulky videa,
 * nechá je YouTube přeložit do cílového jazyka a přečte je nahlas hlasem
 * prohlížeče (Web Speech API), zatímco ztlumí originální zvuk.
 */
(() => {
  "use strict";

  const DEFAULTS = {
    enabled: false,        // automaticky zapnout dabing na novém videu
    targetLang: "cs",      // cílový jazyk
    rate: 1.1,             // rychlost hlasu (0.5–2)
    pitch: 1.0,            // výška hlasu
    volume: 1.0,           // hlasitost dabingu
    voiceURI: "",          // konkrétní hlas (prázdné = automaticky)
    muteOriginal: true     // ztlumit originální zvuk během dabingu
  };

  const LANG_BCP = {
    cs: "cs-CZ", en: "en-US", de: "de-DE",
    sk: "sk-SK", pl: "pl-PL", es: "es-ES"
  };

  let settings = { ...DEFAULTS };
  let active = false;            // dabing právě běží
  let segments = [];             // [{start, dur, text}]
  let segIndex = 0;
  let currentVideoId = null;
  let video = null;
  let prevMuted = null;
  let loading = false;

  // ---------- nastavení ----------
  function loadSettings() {
    return new Promise((resolve) => {
      try {
        chrome.storage.sync.get(DEFAULTS, (s) => {
          settings = { ...DEFAULTS, ...s };
          resolve();
        });
      } catch (e) { resolve(); }
    });
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "sync") return;
    for (const k of Object.keys(changes)) {
      settings[k] = changes[k].newValue;
    }
    // změna jazyka za běhu = znovu načíst titulky
    if (active && changes.targetLang) {
      segments = [];
      ensureSegments().then(() => { segIndex = nearestIndex(video ? video.currentTime : 0); });
    }
    updateButton();
  });

  // zprávy z popupu
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg && msg.type === "DABING_TOGGLE") {
      toggle().then(() => sendResponse({ active }));
      return true;
    }
    if (msg && msg.type === "DABING_STATUS") {
      sendResponse({ active, videoId: getVideoId() });
    }
  });

  // ---------- pomocné ----------
  function getVideoId() {
    const u = new URL(location.href);
    if (u.pathname === "/watch") return u.searchParams.get("v");
    const m = location.pathname.match(/\/(?:shorts|embed)\/([\w-]{11})/);
    return m ? m[1] : null;
  }

  function bcp(lang) { return LANG_BCP[lang] || lang; }

  // ---------- načtení titulků ----------
  async function fetchPlayerResponse(videoId) {
    // Stáhneme stránku watch (stejná doména) a vytáhneme ytInitialPlayerResponse.
    const res = await fetch(`https://www.youtube.com/watch?v=${videoId}`, { credentials: "include" });
    const html = await res.text();
    const marker = "ytInitialPlayerResponse";
    const i = html.indexOf(marker);
    if (i === -1) throw new Error("playerResponse nenalezen");
    const brace = html.indexOf("{", i);
    // najdeme odpovídající uzavírací složenou závorku
    let depth = 0, end = -1, inStr = false, esc = false;
    for (let p = brace; p < html.length; p++) {
      const c = html[p];
      if (inStr) {
        if (esc) esc = false;
        else if (c === "\\") esc = true;
        else if (c === '"') inStr = false;
      } else {
        if (c === '"') inStr = true;
        else if (c === "{") depth++;
        else if (c === "}") { depth--; if (depth === 0) { end = p + 1; break; } }
      }
    }
    if (end === -1) throw new Error("playerResponse neukončen");
    return JSON.parse(html.slice(brace, end));
  }

  function pickTrack(tracks) {
    if (!tracks || !tracks.length) return null;
    // preferuj ruční titulky (ne ASR), jinak první dostupné
    const manual = tracks.find((t) => t.kind !== "asr");
    return manual || tracks[0];
  }

  async function ensureSegments() {
    const vid = getVideoId();
    if (!vid) throw new Error("Není ID videa");
    if (segments.length && currentVideoId === vid) return;
    currentVideoId = vid;
    segments = [];
    const pr = await fetchPlayerResponse(vid);
    const tracks = pr?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
    const track = pickTrack(tracks);
    if (!track) throw new Error("NO_CAPTIONS");
    let url = track.baseUrl;
    // požádej YouTube o překlad do cílového jazyka + JSON formát
    if (settings.targetLang && track.languageCode !== settings.targetLang) {
      url += (url.includes("?") ? "&" : "?") + "tlang=" + encodeURIComponent(settings.targetLang);
    }
    url += "&fmt=json3";
    const r = await fetch(url, { credentials: "include" });
    const data = await r.json();
    const segs = [];
    for (const ev of data.events || []) {
      if (!ev.segs) continue;
      const text = ev.segs.map((s) => s.utf8 || "").join("").replace(/\s+/g, " ").trim();
      if (!text) continue;
      segs.push({ start: (ev.tStartMs || 0) / 1000, dur: (ev.dDurationMs || 0) / 1000, text });
    }
    if (!segs.length) throw new Error("NO_CAPTIONS");
    segments = segs;
  }

  function nearestIndex(t) {
    let i = 0;
    while (i < segments.length && segments[i].start < t - 0.05) i++;
    return i;
  }

  // ---------- TTS ----------
  function getVoices() {
    return window.speechSynthesis ? window.speechSynthesis.getVoices() : [];
  }

  function pickVoice() {
    const voices = getVoices();
    if (settings.voiceURI) {
      const v = voices.find((v) => v.voiceURI === settings.voiceURI);
      if (v) return v;
    }
    const target = bcp(settings.targetLang).toLowerCase();
    const lang2 = settings.targetLang.toLowerCase();
    return (
      voices.find((v) => v.lang.toLowerCase() === target) ||
      voices.find((v) => v.lang.toLowerCase().startsWith(lang2)) ||
      null
    );
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

  // ---------- smyčka dabingu ----------
  function onTimeUpdate() {
    if (!active || !video || !segments.length) return;
    const t = video.currentTime;
    // přeskoč zpožděné segmenty po skoku vpřed – mluv jen aktuální
    let spokeIndex = -1;
    while (segIndex < segments.length && segments[segIndex].start <= t + 0.2) {
      spokeIndex = segIndex;
      segIndex++;
    }
    if (spokeIndex !== -1) {
      const seg = segments[spokeIndex];
      // mluv jen pokud jsme blízko jeho času (ne hluboko za ním)
      if (t - seg.start < (seg.dur || 6) + 1.5) speak(seg.text);
    }
  }

  function onSeeking() {
    if (!active) return;
    try { window.speechSynthesis.cancel(); } catch (e) {}
    segIndex = nearestIndex(video.currentTime);
  }

  function onPause() {
    if (active && window.speechSynthesis) window.speechSynthesis.pause();
  }
  function onPlay() {
    if (active && window.speechSynthesis) window.speechSynthesis.resume();
  }

  function attachVideo() {
    const v = document.querySelector("video.html5-main-video, video.video-stream, video");
    if (v && v !== video) {
      detachVideo();
      video = v;
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

  // ---------- zapnout / vypnout ----------
  async function enable() {
    if (loading) return;
    loading = true;
    updateButton("loading");
    try {
      attachVideo();
      await ensureSegments();
      segIndex = nearestIndex(video ? video.currentTime : 0);
      if (settings.muteOriginal && video) {
        prevMuted = video.muted;
        video.muted = true;
      }
      active = true;
    } catch (e) {
      active = false;
      const msg = e && e.message === "NO_CAPTIONS"
        ? "Toto video nemá titulky, dabing nelze spustit."
        : "Nepodařilo se načíst titulky pro překlad.";
      toast(msg);
      console.warn("[Dabing CZ]", e);
    } finally {
      loading = false;
      updateButton();
    }
  }

  function disable() {
    active = false;
    try { window.speechSynthesis && window.speechSynthesis.cancel(); } catch (e) {}
    if (video && prevMuted !== null) { video.muted = prevMuted; prevMuted = null; }
    updateButton();
  }

  async function toggle() {
    if (active) disable();
    else await enable();
  }

  // ---------- tlačítko v přehrávači ----------
  const BTN_ID = "dabing-cz-btn";

  function svgIcon() {
    // ikona "ústa/řeč" – jednoduchý reproduktor s vlnami
    return `<svg height="100%" viewBox="0 0 36 36" width="100%" fill="#fff">
      <path d="M8 15v6h4l5 5V10l-5 5H8z"></path>
      <path d="M20 13.5c1.6 1 1.6 8 0 9" stroke="#fff" stroke-width="1.6" fill="none" stroke-linecap="round"></path>
      <path d="M22.5 11c3 1.8 3 12.2 0 14" stroke="#fff" stroke-width="1.6" fill="none" stroke-linecap="round"></path>
    </svg>`;
  }

  function ensureButton() {
    const controls = document.querySelector(".ytp-right-controls");
    if (!controls) return;
    if (document.getElementById(BTN_ID)) return;
    const btn = document.createElement("button");
    btn.id = BTN_ID;
    btn.className = "ytp-button dabing-cz-button";
    btn.setAttribute("aria-label", "Dabing CZ");
    btn.innerHTML = `<span class="dabing-cz-icon">${svgIcon()}</span><span class="dabing-cz-badge"></span>`;
    btn.addEventListener("click", (e) => { e.stopPropagation(); toggle(); });
    // vlož před tlačítko titulků, pokud existuje
    const cc = controls.querySelector(".ytp-subtitles-button");
    if (cc) controls.insertBefore(btn, cc);
    else controls.insertBefore(btn, controls.firstChild);
    updateButton();
  }

  function updateButton(state) {
    const btn = document.getElementById(BTN_ID);
    if (!btn) return;
    btn.classList.toggle("dabing-cz-active", active);
    btn.classList.toggle("dabing-cz-loading", state === "loading");
    const badge = btn.querySelector(".dabing-cz-badge");
    if (badge) badge.textContent = (settings.targetLang || "").toUpperCase();
    const langName = (settings.targetLang || "").toUpperCase();
    btn.title = active
      ? `Dabing (${langName}) zapnut – kliknutím vypnete`
      : `Spustit dabing (${langName})`;
  }

  function toast(text) {
    let el = document.getElementById("dabing-cz-toast");
    if (!el) {
      el = document.createElement("div");
      el.id = "dabing-cz-toast";
      document.body.appendChild(el);
    }
    el.textContent = text;
    el.classList.add("show");
    clearTimeout(el._t);
    el._t = setTimeout(() => el.classList.remove("show"), 4000);
  }

  // ---------- SPA navigace ----------
  function onNavigate() {
    // nové video → reset
    const vid = getVideoId();
    if (vid !== currentVideoId) {
      const wasActive = active;
      disable();
      segments = [];
      currentVideoId = vid;
      attachVideo();
      if (wasActive || settings.enabled) {
        // krátké zpoždění, než se přehrávač ustaví
        setTimeout(() => enable(), 1200);
      }
    }
    ensureButton();
  }

  document.addEventListener("yt-navigate-finish", onNavigate);
  window.addEventListener("yt-page-data-updated", onNavigate);

  // MutationObserver – udrž tlačítko v ovládacích prvcích
  const mo = new MutationObserver(() => ensureButton());
  function startObserver() {
    const player = document.querySelector("#movie_player") || document.body;
    mo.observe(document.body, { childList: true, subtree: true });
  }

  // načti hlasy předem
  if (window.speechSynthesis) {
    window.speechSynthesis.onvoiceschanged = () => {};
    getVoices();
  }

  // ---------- start ----------
  loadSettings().then(() => {
    attachVideo();
    ensureButton();
    startObserver();
    if (settings.enabled && getVideoId()) setTimeout(() => enable(), 1500);
  });
})();
