# Unvalidated Play Preview

This artifact enables the frozen `p8-r-hard-balanced-v1` search engine with the
qualification-bound evaluation bundle. It is for hands-on testing while the
official release attestation continues.

It is not a `release-selected` build. It does not claim that final, selected
route, or Phase 9 gates passed. The application displays a permanent warning
when this preview mode is active.

## Run the downloaded artifact

Install Node.js 22.12 or newer, unzip the artifact, and run:

```powershell
node serve-play-preview.mjs
```

Open <http://127.0.0.1:4173>. Keep the terminal open while playing. Press
`Ctrl+C` to stop the local server.

The assistant is manual: enter your exact starting hand and every public play,
pickup, draw, or take-hand event. Recommendations run locally in your browser.
