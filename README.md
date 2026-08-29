# Tato Tracker

Tato Tracker è un planner di studio statico, pensato per GitHub Pages. Divide le pagine di più materie nei giorni disponibili, registra i progressi e può ridistribuire automaticamente gli scostamenti senza usare account o backend.

## Funzioni

- obiettivi con pagine, intervallo, colore e scelta tra giorni settimanali o singole date specifiche;
- calendario mensile con più materie nello stesso giorno;
- modifica del carico di una singola giornata e giorni liberi;
- check-in delle pagine effettivamente studiate;
- redistribuzione automatica opzionale, rispettando i carichi manuali;
- riepilogo complessivo e barre di avanzamento per materia;
- temi chiaro e scuro;
- seconda vista Pomodoro con sessioni e pause configurabili, segnale audio, pianta SVG e registro giornaliero delle sessioni completate mostrato anche nel calendario;
- persistenza in `localStorage` ed export/import JSON.

Al primo avvio vengono mostrati dati di esempio, così tutte le viste sono subito esplorabili. Il pulsante **Ricomincia** crea uno spazio vuoto e questa scelta viene salvata.

## Avvio locale

Non ci sono dipendenze né una build obbligatoria. È possibile aprire direttamente `index.html` oppure servire la cartella con un server statico, ad esempio:

```bash
python -m http.server 8080
```

Poi aprire `http://localhost:8080`.

## Verifica

I controlli di sintassi e i test unitari richiedono Node.js 20 o successivo:

```bash
npm test
npm run check
```

Il test browser opzionale richiede Node.js 23 o successivo e usa Chrome o Edge installato localmente:

```bash
npm run test:browser
```

## Pubblicazione su GitHub Pages

1. Caricare questi file nella root del repository.
2. In **Settings → Pages**, scegliere **Deploy from a branch**.
3. Selezionare il branch principale e la cartella `/ (root)`.

Tutti i riferimenti agli asset sono relativi, quindi il sito funziona anche nel sottopercorso assegnato da GitHub Pages.

## Dati e privacy

I dati sono salvati soltanto nel browser e non vengono sincronizzati. La pulizia dei dati del sito o l'uso di un altro dispositivo può rimuoverli: è consigliabile esportare periodicamente un backup JSON.
# tato-tracker
