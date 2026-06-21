/* Běží v kontextu stránky YouTube. Reaguje na zprávy z content scriptu. */
(function () {
  "use strict";
  function player() { return document.getElementById("movie_player"); }

  function tracks() {
    let pr = null;
    try { const p = player(); if (p && p.getPlayerResponse) pr = p.getPlayerResponse(); } catch (e) {}
    if (!pr) pr = window.ytInitialPlayerResponse || null;
    const list = (pr && pr.captions && pr.captions.playerCaptionsTracklistRenderer &&
      pr.captions.playerCaptionsTracklistRenderer.captionTracks) || [];
    return list.map((t) => ({ baseUrl: t.baseUrl, languageCode: t.languageCode, kind: t.kind || "" }));
  }

  function enableCaptions(lang) {
    const p = player();
    if (!p || !p.setOption) return { ok: false, reason: "no-api" };
    try {
      if (p.loadModule) p.loadModule("captions");
      let list = [];
      try { list = p.getOption("captions", "tracklist") || []; } catch (e) {}
      if (!list.length) { try { list = p.getOption("captions", "tracklist", { includeAsr: true }) || []; } catch (e) {} }
      const base = list[0] || {};
      try { p.setOption("captions", "track", base); } catch (e) {}
      if (lang) {
        try { p.setOption("captions", "translationLanguage", { languageCode: lang }); } catch (e) {}
        try { p.setOption("captions", "track", base); } catch (e) {}
      }
      try { p.setOption("captions", "reload", true); } catch (e) {}
      return { ok: true, tracks: list.length };
    } catch (e) { return { ok: false, reason: String(e) }; }
  }

  window.addEventListener("message", function (ev) {
    if (ev.source !== window || !ev.data || ev.data.__dabing == null) return;
    const d = ev.data;
    if (d.__dabing === "req") {
      window.postMessage({ __dabing: "res", id: d.id, tracks: tracks() }, "*");
    } else if (d.__dabing === "enable") {
      const r = enableCaptions(d.lang);
      window.postMessage({ __dabing: "enabled", id: d.id, result: r }, "*");
    } else if (d.__dabing === "vol") {
      try { const p = player(); if (p && p.setVolume) p.setVolume(Math.max(0, Math.min(100, Math.round(d.value)))); } catch (e) {}
    }
  });
})();
