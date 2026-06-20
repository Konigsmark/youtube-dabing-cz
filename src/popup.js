const DEFAULTS = { enabled:false, targetLang:"cs", rate:1.1 };

const $ = (id) => document.getElementById(id);
const toggleBtn = $("toggle");
const langSel = $("lang");
const rate = $("rate");
const rateVal = $("rateVal");
const statusEl = $("status");

let isActive = false;

function setBtn() {
  toggleBtn.textContent = isActive ? "Vypnout dabing" : "Spustit dabing";
  toggleBtn.classList.toggle("on", isActive);
}

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

async function init() {
  const s = await chrome.storage.sync.get(DEFAULTS);
  langSel.value = s.targetLang;
  rate.value = s.rate;
  rateVal.textContent = (+s.rate).toFixed(1) + "×";

  const tab = await activeTab();
  if (!tab || !/^https:\/\/www\.youtube\.com\//.test(tab.url || "")) {
    statusEl.textContent = "Otevřete video na youtube.com.";
    toggleBtn.disabled = true;
    return;
  }
  try {
    const resp = await chrome.tabs.sendMessage(tab.id, { type: "DABING_STATUS" });
    isActive = !!(resp && resp.active);
  } catch (e) {
    statusEl.textContent = "Načtěte (F5) stránku videa.";
  }
  setBtn();
}

toggleBtn.addEventListener("click", async () => {
  const tab = await activeTab();
  try {
    const resp = await chrome.tabs.sendMessage(tab.id, { type: "DABING_TOGGLE" });
    isActive = !!(resp && resp.active);
    setBtn();
    statusEl.textContent = isActive ? "Dabing běží." : "";
  } catch (e) {
    statusEl.textContent = "Načtěte (F5) stránku videa a zkuste znovu.";
  }
});

langSel.addEventListener("change", () => {
  chrome.storage.sync.set({ targetLang: langSel.value });
});

rate.addEventListener("input", () => {
  rateVal.textContent = (+rate.value).toFixed(1) + "×";
  chrome.storage.sync.set({ rate: +rate.value });
});

$("openOptions").addEventListener("click", (e) => {
  e.preventDefault();
  chrome.runtime.openOptionsPage();
});

init();
