/* Běží v kontextu stránky YouTube (ne v izolovaném světě content scriptu).
 * Na vyžádání vrátí seznam titulkových tracků z aktuálního přehrávače. */
(function () {
  "use strict";
  function tracks() {
    let pr = null;
    try {
      const p = document.getElementById("movie_player");
      if (p && typeof p.getPlayerResponse === "function") pr = p.getPlayerResponse();
    } catch (e) {}
    if (!pr) pr = window.ytInitialPlayerResponse || null;
    const list =
      (pr && pr.captions &&
        pr.captions.playerCaptionsTracklistRenderer &&
        pr.captions.playerCaptionsTracklistRenderer.captionTracks) || [];
    return list.map((t) => ({
      baseUrl: t.baseUrl,
      languageCode: t.languageCode,
      kind: t.kind || "",
      name:
        (t.name && (t.name.simpleText ||
          (t.name.runs && t.name.runs[0] && t.name.runs[0].text))) || ""
    }));
  }
  window.addEventListener("message", function (ev) {
    if (ev.source !== window || !ev.data || ev.data.__dabing !== "req") return;
    window.postMessage({ __dabing: "res", id: ev.data.id, tracks: tracks() }, "*");
  });
})();
