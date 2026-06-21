# YouTube Dabing CZ 🎙️

Rozšíření pro Google Chrome (Manifest V3), které **dabuje YouTube videa do češtiny** (i jiných jazyků)
přímo v přehrávači. Vedle tlačítka titulků (CC) přidá tlačítko **DAB**; po jeho zapnutí ztlumí/zeslabí
originál a pustí český překlad. Nabízí několik hlasových enginů – od zdarma vestavěného hlasu až po
**skutečný real‑time AI dabing audio→audio přes Google Gemini Live**.

## Hlasové enginy

V nastavení si vybíráš engine (pořadí: Google / Azure / ElevenLabs / vestavěný):

1. **Google (Gemini Live) – skutečný dabing audio→audio** *(doporučeno)*
   Zvuk videa jde přímo do modelu `gemini-3.5-live-translate-preview`, zpátky chodí
   **český hlas se zachovanou intonací** (Speech‑to‑Speech). Nepotřebuje titulky.
   Vyžaduje vlastní **Gemini API klíč** (aistudio.google.com), je **placené** (preview).
2. **Microsoft Natural přes Azure** (Vlasta/Antonín) – neuronové hlasy, free tarif 500k znaků/měsíc.
3. **ElevenLabs** – neuronový hlas (placené).
4. **Vestavěný hlas prohlížeče** (zdarma, např. Microsoft Jakub) – čte přeložené titulky.

> Enginy 2–4 čtou **titulky** videa (je potřeba mít zapnuté CC, případně auto‑překlad).
> Engine 1 (Gemini) titulky nepotřebuje – pracuje přímo se zvukem.

## Hlavní funkce

- Tlačítko **DAB** v přehrávači (+ plovoucí tlačítko jako fallback).
- Výstupní jazyk: čeština, angličtina, němčina, slovenština, polština, španělština.
- **Zeslabení originálu** během dabingu (výchozí 20 %, nastavitelné).
- **Vlastní titulek** s přepisem dabovaného hlasu (žlutý, 2 řádky, rolování po větách) – u Gemini enginu.
- **Nahrávání do souboru** (Gemini engine): ulož si přehrané **VIDEO** (`.webm`, obraz + český zvuk)
  a/nebo **AUDIO** (`.wav`, jen dabing pro střih). Soubory se pojmenují podle názvu videa:
  `Název videa-dabing.webm` / `.wav`. Zaplatíš jen jedno přehrání, soubor pak používáš zdarma.

## Instalace (nezabalená / vývojová)

1. `chrome://extensions` → vpravo nahoře zapni **Režim pro vývojáře**.
2. **Načíst rozbalené** → vyber složku `youtube-dabing-cz`.
3. Otevři YouTube video a klikni na **DAB**.

> Pozn.: Gemini engine používá zachytávání zvuku karty (`tabCapture`), které vyžaduje, aby bylo
> rozšíření na stránce **vyvoláno přes ikonu v liště** – proto Gemini dabing spouštěj kliknutím
> na ikonu rozšíření (popup), ne jen tlačítkem na stránce.

## Nastavení Gemini

1. Vytvoř si API klíč na **aistudio.google.com/apikey**.
2. V **Možnostech** rozšíření: engine = *Google (Gemini Live)*, vlož klíč, ulož.
3. Zaškrtni, jestli chceš titulek a/nebo nahrávání do souboru.

## Náklady (Gemini Live, orientačně)

Účtuje se zvuk: vstup ~$0,0053/min, výstup ~$0,0315/min → **~$0,037/min**, tj. **hodina ≈ $2 (~50 Kč)**.
Spotřebu sleduj v Google AI Studiu (Usage / Spend).

## Struktura

```
youtube-dabing-cz/
├── manifest.json
├── icons/
└── src/
    ├── content.js     – tlačítka, titulky, řízení enginů
    ├── content.css
    ├── background.js  – řízení Gemini (tabCapture, offscreen)
    ├── offscreen.js   – zachyt zvuku/obrazu, Gemini WS, přehrání, nahrávání souborů
    ├── inject.js      – ovládání hlasitosti přehrávače
    ├── popup.html/js
    ├── options.html/js
    └── ui.css
```

## Omezení / poznámky

- Gemini dabing má proti obrazu **pár vteřin zpoždění** (model překládá s odstupem) – platí i pro nahrané video.
- Nahrané soubory jsou **WebM/WAV**; na MP4 převedeš např. v HandBrake/VLC, WAV otevře každý střihový SW.
- „Google Live Translate 3.5" = model `gemini-3.5-live-translate-preview` (Gemini Live API).

## Licence

MIT – viz `LICENSE`.
