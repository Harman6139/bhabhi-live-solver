# Playable local build

The default `dist/` build runs **E**, the practical exact-endgame engine with
the dependable R search as its fallback. Start it with:

```powershell
node scripts/serve-play-preview.mjs dist
```

Open <http://127.0.0.1:4173>. Keep that terminal open while playing.

Setup asks only for your exact cards, who received the 18th/extra card, and who
plays Hukam (the A♠ opener). Counts are derived automatically. New games are
counterclockwise. Record each observed card; thulla pickups and transferred
table cards are applied to the hand counts and retained in the local archive.

## Available engines

| Mode | Build folder               | Readiness                                                                           |
| ---- | -------------------------- | ----------------------------------------------------------------------------------- |
| E    | `dist/`                    | Recommended practical build: exact endgame when tractable, R fallback otherwise     |
| R    | `work/playable-models/r/`  | Formally selected baseline; frozen Balanced final Bhabhi rate 446/3,264 (13.66%)    |
| B    | `work/playable-models/b/`  | Fitted behavior model, practical/unsealed; may refuse unsupported states            |
| BE   | `work/playable-models/be/` | Exact plus fitted behavior model, practical/unsealed; may refuse unsupported states |

To try another build, stop the current server with `Ctrl+C`, then pass its
folder to the same server script, for example:

```powershell
node scripts/serve-play-preview.mjs work/playable-models/r
```

B and BE use the real completed behavior fit plus a fixed conservative support
pseudocount of 1. They make no qualification or win-rate claim. They are kept
separate from the default because their sealing audit found unsupported truth
cells; no fabricated validation result is used.

The compact UI requests Deep analysis and applies a post-freeze same-suit
high-card preference only when estimated terminal risks are exactly tied. The
13.66% figure belongs to the frozen Balanced R evaluation, not to E, Deep, or
that tie-policy adjustment.
