// pi-game-worker.js — Cloudflare Worker (Modules)
// Fix: kein Remote-Import; SHA-256 via WebCrypto; faire Tier-Chancen; Kandidat vor Win-Roll

// ---- Util: SHA-256 → Hex (WebCrypto) ----
async function sha256Hex(input) {
  const enc = new TextEncoder().encode(input);
  const buf = await crypto.subtle.digest("SHA-256", enc);
  const view = new Uint8Array(buf);
  let hex = "";
  for (let i = 0; i < view.length; i++) {
    const h = view[i].toString(16).padStart(2, "0");
    hex += h;
  }
  return hex;
}

const CFG = {
  RPCS: ["https://api.mainnet-beta.solana.com"],

  // JSON mit deiner Raritätstabelle (ggf. anpassen, falls Pfad abweicht)
  DATA_URL: "https://inpinity.online/game/data/pi_phi_table.json",

  CREATOR: "GEFoNLncuhh4nH99GKvVEUxe59SGe74dbLG7UUtfHrCp",
  INPI_MINT: "GBfEVjkSn3KSmRnqe83Kb8c42DsxkJmiDCb4AbNYBYt1",
  USDC_MINT: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",

  TREASURY_OWNER: "GEFoNLncuhh4nH99GKvVEUxe59SGe74dbLG7UUtfHrCp", // INPI 80%
  LP_OWNER:       "GEFoNLncuhh4nH99GKvVEUxe59SGe74dbLG7UUtfHrCp", // USDC → LP
  INCINERATOR_OWNER: "1nc1nerator11111111111111111111111111111111", // INPI 20% Burn

  COST_INPI: 2000,
  COST_USDC: 1,

  // Faire Basis-Chancen pro Tier (BPS = 0.01%)
  TIER_BASE_BPS: { Legendary: 314, Epic: 700, Rare: 1200, Common: 1200 },
  BOOST_BPS: 100,  // +1.00% zur vollen Stunde
  FREE_BPS:  100,  // +1.00% Gratis-Run
  MIN_BPS:    50,  // ≥ 0.50%
  MAX_BPS:  5000,  // ≤ 50%

  // Nur für Auswahlgewichtung (nicht für Win-Chance)
  TIER_WEIGHTS: { Legendary: 0.05, Epic: 0.15, Rare: 0.30, Common: 1.00 },
  BONUS_AXIS: -0.05,
  BONUS_PI_EQ_PHI: -0.10,
  BONUS_MATCH_PAIR: -0.15
};

// ---------- Helpers ----------
function CORS(h) {
  return new Headers({
    "content-type": "application/json",
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET,POST,OPTIONS",
    "access-control-allow-headers": "*",
    ...h
  });
}

async function rpc(method, params) {
  const url = CFG.RPCS[Math.floor(Math.random() * CFG.RPCS.length)];
  const r = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params })
  });
  const j = await r.json();
  if (j.error) throw new Error(j.error.message);
  return j.result;
}

async function latestBlockhash() {
  const r = await rpc("getLatestBlockhash", [{ commitment: "finalized" }]);
  return r.blockhash;
}

async function getTx(sig) {
  return await rpc("getTransaction", [sig, { maxSupportedTransactionVersion: 0, commitment: "confirmed" }]);
}

// Europe/Berlin – volle Stunde = Boost
function berlinMinute() {
  const d = new Date();
  const m = d.getUTCMonth();
  const offset = (m >= 2 && m <= 9) ? 2 : 1; // Sommerzeit grob
  const b = new Date(d.getTime() + offset * 3600 * 1000);
  return b.getMinutes();
}
function communityBoost() { return berlinMinute() === 0; }

// ---------- Pool / Auswahl ----------
async function loadPool(env) {
  let s = await env.GAME.get("POOL_JSON");
  if (!s) {
    const res = await fetch(CFG.DATA_URL, { cf: { cacheEverything: true }});
    s = await res.text();
    await env.GAME.put("POOL_JSON", s, { expirationTtl: 300 });
  }
  const arr = JSON.parse(s);
  const claimed = JSON.parse(await env.GAME.get("CLAIMED_SET") || "[]");
  const set = new Set(claimed);
  return arr.filter(o => !set.has(o.id));
}

function weightOf(o) {
  let w = CFG.TIER_WEIGHTS[o.tier] ?? 1.0;
  if (o.is_axis) w += CFG.BONUS_AXIS;
  if (o.pi_equals_phi) w += CFG.BONUS_PI_EQ_PHI;
  if (o.is_in_matching_pair) w += CFG.BONUS_MATCH_PAIR;
  return Math.max(0.01, w);
}

function pickWeighted(arr, seedHex) {
  // deterministisch aus Seed erste 8 Hex-Zeichen
  const seedNum = parseInt(seedHex.slice(0, 8), 16);
  const total = arr.reduce((s, o) => s + weightOf(o), 0);
  let r = (seedNum % 1_000_000) / 1_000_000 * total;
  for (const o of arr) {
    const w = weightOf(o);
    if (r < w) return o;
    r -= w;
  }
  return arr[arr.length - 1];
}

async function recordClaim(env, id, wallet) {
  let claimed = JSON.parse(await env.GAME.get("CLAIMED_SET") || "[]");
  if (!claimed.includes(id)) {
    claimed.push(id);
    await env.GAME.put("CLAIMED_SET", JSON.stringify(claimed));
  }
  await env.CLAIMS.put(String(id), JSON.stringify({ id, wallet, ts: Date.now() }));
}

// ---------- Streak / Sigs ----------
async function incLossStreak(env, wallet, won) {
  const key = `STREAK:${wallet}`;
  const cur = parseInt(await env.GAME.get(key) || "0", 10);
  const next = won ? 0 : cur + 1;
  await env.GAME.put(key, String(next));
  return next;
}
async function getStreak(env, wallet) {
  return parseInt(await env.GAME.get(`STREAK:${wallet}`) || "0", 10);
}
async function markSigUsed(env, sig) {
  await env.GAME.put(`SIG:${sig}`, "1", { expirationTtl: 86400 });
}
async function isSigUsed(env, sig) {
  return Boolean(await env.GAME.get(`SIG:${sig}`));
}

// ---------- Payment Verify ----------
async function verifyPayment(env, body) {
  if (body.mode === "FREE") {
    const streak = await getStreak(env, body.wallet);
    if (streak < 3) throw new Error("Gratis-Run nicht freigeschaltet (3 Nieten nötig).");
    return { paid: false, amount: 0, mint: null };
  }

  if (!body.txSig) throw new Error("txSig fehlt.");
  if (await isSigUsed(env, body.txSig)) throw new Error("txSig bereits verwendet.");

  const tx = await getTx(body.txSig);
  if (!tx) throw new Error("Transaktion nicht gefunden.");

  const pay = body.pay || "INPI";
  const expectedMint = (pay === "USDC") ? CFG.USDC_MINT : CFG.INPI_MINT;
  const decs = (pay === "USDC") ? 6 : 9;
  const expectedAmount = (pay === "USDC")
    ? Math.floor(CFG.COST_USDC * 10 ** decs)   // 1.000000
    : Math.floor(CFG.COST_INPI * 10 ** decs);  // 2000e9

  const pre  = tx.meta?.preTokenBalances  || [];
  const post = tx.meta?.postTokenBalances || [];
  const owner = body.wallet;

  const ownerPre  = pre.find(b => b.owner === owner && b.mint === expectedMint);
  const ownerPost = post.find(b => b.owner === owner && b.mint === expectedMint);
  if (!ownerPre || !ownerPost) throw new Error("Owner Token-Balance nicht gefunden.");

  const delta = Number(ownerPre.uiTokenAmount.amount) - Number(ownerPost.uiTokenAmount.amount);
  if (delta < expectedAmount) throw new Error("Zahlbetrag zu niedrig.");

  await markSigUsed(env, body.txSig);
  return { paid: true, amount: delta, mint: expectedMint };
}

// ---------- RNG ----------
function rollBps(seedHex) {
  // 0..9999, deterministisch aus letztem Nibble-Quartett
  return parseInt(seedHex.slice(-4), 16) % 10000;
}

// ---------- Worker ----------
export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") return new Response("", { headers: CORS() });
    const url = new URL(request.url);

    if (url.pathname.endsWith("/healthz")) {
      return new Response(JSON.stringify({ ok: true }), { headers: CORS() });
    }

    if (url.pathname.endsWith("/config")) {
      return new Response(JSON.stringify({
        cost: { inpi: CFG.COST_INPI, usdc: CFG.COST_USDC },
        tiers_bps: CFG.TIER_BASE_BPS,
        community_boost_active: communityBoost(),
        free_rule: "4. Runde gratis nach 3 Nieten"
      }), { headers: CORS() });
    }

    if (url.pathname.endsWith("/play") && request.method === "POST") {
      try {
        const body = await request.json();
        await verifyPayment(env, body);

        // Seed aus wallet + txSig/FREE + finalized blockhash
        const blockhash = await latestBlockhash();
        const seed = await sha256Hex(body.wallet + (body.txSig || "FREE") + blockhash);
        const boost = communityBoost();
        const free  = body.mode === "FREE";

        // 1) Kandidat (noch nicht vergebene) — gewichtete Auswahl
        const pool = await loadPool(env);
        if (!pool.length) throw new Error("Alle NFTs vergeben.");
        const candidate = pickWeighted(pool, seed);

        // 2) per-Item Chance über Tier + Boosts
        let bps = CFG.TIER_BASE_BPS[candidate.tier] ?? 500; // Fallback 5.00%
        if (boost) bps += CFG.BOOST_BPS;
        if (free)  bps += CFG.FREE_BPS;
        bps = Math.max(CFG.MIN_BPS, Math.min(CFG.MAX_BPS, bps));

        // 3) rollen
        const r = rollBps(seed);
        const won = (r < bps);

        // 4) Streak & Ergebnis
        const streakNext = await incLossStreak(env, body.wallet, won);
        const result = { won, streakNext };

        // 5) Gewinn verbuchen
        if (won) {
          await recordClaim(env, candidate.id, body.wallet);
          result.id = candidate.id;
          result.tier = candidate.tier;
        }

        // 6) Proof
        const proof = {
          wallet: body.wallet,
          txSig: body.txSig || null,
          blockhash,
          boostActive: boost,
          mode: body.mode,
          bps, roll: r,
          seed: seed.slice(0,16) + "…",
          verify: `${url.origin}/verify?w=${body.wallet}&s=${(body.txSig||"FREE")}`
        };

        return new Response(JSON.stringify({ ok: true, result, proof }), { headers: CORS() });
      } catch (e) {
        return new Response(JSON.stringify({ ok: false, error: e.message }), { status: 400, headers: CORS() });
      }
    }

    return new Response(JSON.stringify({ ok: false, error: "not found" }), { status: 404, headers: CORS() });
  }
}