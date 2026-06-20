# YouTube Dabing CZ 🎙️

Rozšíření pro Google Chrome (Manifest V3), které přidá do ovládacích prvků
přehrávače YouTube – hned vedle tlačítka titulků (CC) – tlačítko **Dabing**.
Po jeho stisknutí rozšíření načte titulky videa, nechá je YouTube přeložit do
zvoleného jazyka (výchozí **čeština**) a **přečte je nahlas hlasem prohlížeče**,
zatímco ztlumí originální zvuk. Výsledkem je „dabing" videa.

## Jak to funguje

1. Klik na tlačítko v přehrávači → načte se titulkový track videa.
2. YouTube je požádán o překlad titulků do cílového jazyka (parametr `tlang`).
3. Přeložené segmenty se synchronně s časem videa předčítají přes
   Web Speech API (`SpeechSynthesis`).
4. Originální zvuk je po dobu dabingu ztlumen.

## Nastavení

- Výstupní jazyk: čeština, angličtina, němčina, slovenština, polština, španělština.
- Rychlost, výška a hlasitost hlasu, výběr konkrétního systémového hlasu.
- Automatické spuštění na každém videu, ztlumení originálu.

Nastavení je dostupné v okně rozšíření (popup) i na stránce možností.

## Instalace (vývojová / nezabalená)

1. Otevři `chrome://extensions`.
2. Vpravo nahoře zapni **Režim pro vývojáře**.
3. Klikni **Načíst rozbalené** a vyber složku `youtube-dabing-cz`.
4. Otevři libovolné YouTube video s titulky a klikni na nové tlačítko 🎙️.

## ⚠️ Omezení (čti, prosím)

- **Funguje jen u videí, která mají titulky** (i automaticky generované).
  Bez titulků nelze překlad získat.
- Nejde o náhradu hlasu mluvčího ani o klonování hlasu – jde o **předčítání
  přeložených titulků** počítačovým hlasem, synchronně s videem.
- Kvalita a dostupnost hlasů závisí na operačním systému / prohlížeči.
- „Google Live Translate 3.5" není veřejné API; tato verze místo něj využívá
  vestavěný překlad titulků YouTube (zdarma, bez API klíče).

## Možná budoucí vylepšení (cesta k „plnému" dabingu)

- Vlastní STT (rozpoznání řeči) pro videa bez titulků – vyžaduje cloudovou
  službu a serverovou část.
- Neuronový TTS / klonování hlasu pro přirozenější dabing (placené API).
- Lepší časová synchronizace a fronta promluv.

## Struktura

```
youtube-dabing-cz/
├── manifest.json
├── icons/            (16/48/128 px)
└── src/
    ├── content.js    – injektáž tlačítka + dabing engine
    ├── content.css   – styl tlačítka v přehrávači
    ├── popup.html/js – rychlé ovládání
    ├── options.html/js – podrobné nastavení
    └── ui.css        – styl popupu a nastavení
```

## Licence

MIT – viz `LICENSE`.
