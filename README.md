# inpi-pi-game

# INPI Pi-Pyramid Game

- Frontend (GitHub Pages): `pages/game/`
- Worker (Cloudflare): `worker/`
- Daten: `pages/game/data/pi_phi_table.json` (deine 10.000 Blöcke mit Tier/Flags)

## Kosten
- INPI: 2000 (20% Burn, 80% Treasury)
- USDC: 1.00 (voll an LP)

## Deploy
1) JSON nach `pages/game/data/pi_phi_table.json`.
2) Repo auf GitHub -> Pages (Branch main, Root: /pages/game).
3) `cd worker`
   - `wrangler kv:namespace create GAME`
   - `wrangler kv:namespace create CLAIMS`
   - `wrangler publish`
4) DNS/Route: `api.inpinity.online/game*` -> Worker.
5) In `pages/game/app.js` ist `API_BASE` bereits auf `https://api.inpinity.online/game`.

## Prüfen
- Frontend öffnen -> Phantom verbinden -> INPI/USDC wählen -> Play.
- Worker-Logs: `wrangler tail` (in `worker/`).