// Frontend mit Phantom, API, Boost-Countdown, Explorer-Link,
// NFT-Preview (IPFS robust) + Thumbs mit Pager (0–399) + Pixelate
// Owner-Check via Helius (optional) + Rarity-Liste (optional)

import { runPiRoll } from "./three-scene.js?v=1";

/* ------------------ Solana libs ------------------ */
// web3.js als IIFE-Bundle (Namespace-Import, dann Destrukturierung)
import * as web3 from "https://cdn.jsdelivr.net/npm/@solana/web3.js@1.95.3/lib/index.iife.min.js";
const { Connection, PublicKey, Transaction } = web3;

// spl-token als ESM (kein IIFE verfügbar) – mit Bundle + passendem Target
import {
  getAssociatedTokenAddress,
  createAssociatedTokenAccountInstruction,
  createTransferCheckedInstruction
} from "https://esm.sh/@solana/spl-token@0.4.8?bundle&target=es2020";

/* ------------------ Config ------------------ */
const CFG = {
  RPCS: ["https://api.mainnet-beta.solana.com"],
  INPI_MINT: "GBfEVjkSn3KSmRnqe83Kb8c42DsxkJmiDCb4AbNYBYt1",
  USDC_MINT: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  TREASURY_OWNER: "GEFoNLncuhh4nH99GKvVEUxe59SGe74dbLG7UUtfHrCp", // INPI 80%
  INCINERATOR_OWNER: "1nc1nerator11111111111111111111111111111111",  // INPI 20% Burn
  LP_OWNER: "GEFoNLncuhh4nH99GKvVEUxe59SGe74dbLG7UUtfHrCp",          // USDC → LP
  COST_INPI: 2000,
  COST_USDC: 1,
  API_BASE: "https://api.inpinity.online/game",
  INPI_DECIMALS: 9,
  USDC_DECIMALS: 6,

  // --- IPFS robust (NEW) ---
  // Hinweis: Die echten Medienpfade nehmen wir aus den Metadaten (animation_url/image).
  // Diese Gateways werden nacheinander probiert; plus optional Worker-Proxy.
  GATEWAYS: [
    "https://nftstorage.link/ipfs/",
    "https://dweb.link/ipfs/",
    "https://cloudflare-ipfs.com/ipfs/",
    "https://ipfs.io/ipfs/",
    "https://gateway.pinata.cloud/ipfs/"
  ],
  // Optional: Proxy über deinen Worker (CORS-frei). Im Worker Route /ipfs/:cid/:path* spiegeln.
  // Beispiel: "https://api.inpinity.online/game/ipfs/"
  IPFS_PROXY_PREFIX: "https://api.inpinity.online/game/ipfs/", // falls nicht vorhanden: Worker später ergänzen
  IPFS_TIMEOUT_MS: 5000,

  // --- Metadaten-Quelle (Rarity JSON) ---
  RARITY_URL: "https://inpinity.online/game/data/pi_phi_table.json",

  // --- Helius (Owner/Asset Lookup) (NEW) ---
  HELIUS_API_KEY: "d95932bb-5385-4d84-ad18-7fc66e014d58", // <— hier deinen Key eintragen (oder leer lassen)
  COLLECTION: "6xvwKXMUGfkqhs1f3ZN3KkrdvLh2vF3tX1pqLo9aYPrQ", // Pi Pyramide Collection
  COLLECTION_NAME_PREFIX: "Pi Pyramide #", // Name-Muster für Suche
};

/* ------------------ SHA-256 via WebCrypto ------------------ */
async function sha256Hex(str){
  const data = new TextEncoder().encode(str);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hash)).map(b=>b.toString(16).padStart(2,"0")).join("");
}

/* ------------------ DOM ------------------ */
const $ = (s)=>document.querySelector(s);
const btnConnect = $("#btnConnect");
const btnPlay    = $("#btnPlay");
const spanInpi   = $("#balInpi");
const spanUsdc   = $("#balUsdc");
const spanCost   = $("#usdcCost");
const resultEl   = $("#result");
const proofEl    = $("#proof");
const hintEl     = $("#hint");
const linksEl    = $("#links");
const boostTimerEl = $("#boostTimer");

// NFT Visual
const autoPreviewEl = $("#autoPreview");
const grid16El      = $("#grid16");
const pixelateEl    = $("#pixelate");
const btnShowId     = $("#btnShowId");
const btnRandom     = $("#btnRandom");
const btnLoadThumbs = $("#btnLoadThumbs");
const manualIdInput = $("#manualId");
const nftVideo      = $("#nftVideo");
const nftImage      = $("#nftImage");
const gridOverlay   = $("#gridOverlay");
const metaBox       = $("#meta");
const thumbBar      = $("#thumbBar");
const pageInfo      = $("#pageInfo");
const prevPage      = $("#prevPage");
const nextPage      = $("#nextPage");
const rarityListEl  = $("#rarityList");   // optional <ul id="rarityList"></ul>
const ownerLineEl   = $("#ownerLine");    // optional <div id="ownerLine"></div>

// Kostenanzeige
if (spanCost) spanCost.textContent = Number(CFG.COST_USDC).toFixed(2);

let wallet = null;
let connection = null;
let lastSig = null;

// Frontend-Cache
const META_CACHE = new Map();  // id -> json
const THUMB_CACHE = new Map(); // id -> url
const RARITY_CACHE = { loaded: false, byId: new Map(), counts: null };

/* ------------------ Helpers ------------------ */
function pickRpc(){ return CFG.RPCS[Math.floor(Math.random()*CFG.RPCS.length)]; }
async function ensureConn(){ return connection ?? (connection = new Connection(pickRpc(), "confirmed")); }
async function getAta(mint, owner){ return await getAssociatedTokenAddress(new PublicKey(mint), new PublicKey(owner), false); }

/* --- Token-Balance: Summiere alle Accounts (NEW) --- */
async function fetchTokenBalanceSum(mint, owner, decimals) {
  const conn = await ensureConn();
  const resp = await conn.getParsedTokenAccountsByOwner(new PublicKey(owner), { mint: new PublicKey(mint) }).catch(()=>null);
  if (!resp?.value?.length) return { raw: 0n, ui: 0 };
  let total = 0n;
  for (const it of resp.value) {
    const amt = it.account?.data?.parsed?.info?.tokenAmount?.amount ?? "0";
    try { total += BigInt(amt); } catch {}
  }
  return { raw: total, ui: Number(total) / 10**decimals };
}

async function refreshBalances() {
  if (!wallet) return;
  const [inpi, usdc] = await Promise.all([
    fetchTokenBalanceSum(CFG.INPI_MINT, wallet.publicKey, CFG.INPI_DECIMALS),
    fetchTokenBalanceSum(CFG.USDC_MINT, wallet.publicKey, CFG.USDC_DECIMALS),
  ]);
  if (spanInpi) spanInpi.textContent = inpi.ui.toFixed(4);
  if (spanUsdc) spanUsdc.textContent = usdc.ui.toFixed(4);
}

/* ------------------ Europe/Berlin Boost ------------------ */
function nowBerlin() {
  const d = new Date();
  const m = d.getUTCMonth();
  const offset = (m>=2 && m<=9) ? 2 : 1;
  return new Date(d.getTime() + offset*3600*1000);
}
function secsToNextFullHour() {
  const b = nowBerlin();
  const next = new Date(b);
  next.setMinutes(0, 0, 0);
  if (b.getMinutes() !== 0 || b.getSeconds() !== 0) next.setHours(b.getHours() + 1);
  return Math.max(0, Math.floor((next - b) / 1000));
}
function formatMMSS(total) {
  const m = Math.floor(total/60);
  const s = total % 60;
  return `${String(m).padStart(2,"0")}:${String(s).padStart(2,"0")}`;
}
function updateBoostUI() {
  const secs = secsToNextFullHour();
  if (!hintEl || !boostTimerEl) return;
  if (secs === 0) { hintEl.textContent = "Community-Boost aktiv: +1.00% Chance"; boostTimerEl.textContent = "Jetzt!"; }
  else { hintEl.textContent = "Tipp: Zur vollen Stunde +1.00% Boost"; boostTimerEl.textContent = "Nächster Boost in " + formatMMSS(secs); }
}
setInterval(updateBoostUI, 1000); updateBoostUI();

/* ------------------ Wallet ------------------ */
if (btnConnect) {
  btnConnect.onclick = async () => {
    if (!window?.solana?.isPhantom) return alert("Phantom Wallet nicht gefunden. Bitte Phantom installieren.");
    const resp = await window.solana.connect();
    wallet = resp;
    btnConnect.textContent = `Verbunden: ${wallet.publicKey.toBase58().slice(0,6)}…`;
    await ensureConn();
    await refreshBalances();
  };
}

/* ------------------ Zahlungen ------------------ */
async function buildInpiTx(payer) {
  const conn = await ensureConn();
  const mint = new PublicKey(CFG.INPI_MINT);
  const decimals = CFG.INPI_DECIMALS;
  const amount = BigInt(CFG.COST_INPI * 10**decimals);
  const amtBurn  = amount * 20n / 100n;
  const amtTreas = amount - amtBurn;

  const ix = [];
  const payerPk = new PublicKey(payer);
  const treasOwner = new PublicKey(CFG.TREASURY_OWNER);
  const burnOwner  = new PublicKey(CFG.INCINERATOR_OWNER);

  const ataPayer = await getAssociatedTokenAddress(mint, payerPk);
  const ataTreas = await getAssociatedTokenAddress(mint, treasOwner);
  const ataBurn  = await getAssociatedTokenAddress(mint, burnOwner);

  const infos = await conn.getMultipleAccountsInfo([ataTreas, ataBurn]);
  if (!infos[0]) ix.push(createAssociatedTokenAccountInstruction(payerPk, ataTreas, treasOwner, mint));
  if (!infos[1]) ix.push(createAssociatedTokenAccountInstruction(payerPk, ataBurn,  burnOwner,  mint));

  ix.push(createTransferCheckedInstruction(ataPayer, mint, ataBurn,  payerPk, Number(amtBurn),  decimals));
  ix.push(createTransferCheckedInstruction(ataPayer, mint, ataTreas, payerPk, Number(amtTreas), decimals));

  const tx = new Transaction().add(...ix);
  tx.feePayer = payerPk;
  tx.recentBlockhash = (await conn.getLatestBlockhash("finalized")).blockhash;
  return tx;
}

async function buildUsdcTx(payer) {
  const conn = await ensureConn();
  const mint = new PublicKey(CFG.USDC_MINT);
  const decimals = CFG.USDC_DECIMALS;
  const amount = BigInt(CFG.COST_USDC * 10**decimals); // 1.00 USDC

  const ix = [];
  const payerPk = new PublicKey(payer);
  const lpOwner = new PublicKey(CFG.LP_OWNER);

  const ataPayer = await getAssociatedTokenAddress(mint, payerPk);
  const ataLp    = await getAssociatedTokenAddress(mint, lpOwner);

  const info = await conn.getAccountInfo(ataLp);
  if (!info) ix.push(createAssociatedTokenAccountInstruction(payerPk, ataLp, lpOwner, mint));
  ix.push(createTransferCheckedInstruction(ataPayer, mint, ataLp, payerPk, Number(amount), decimals));

  const tx = new Transaction().add(...ix);
  tx.feePayer = payerPk;
  tx.recentBlockhash = (await conn.getLatestBlockhash("finalized")).blockhash;
  return tx;
}

/* ------------------ API ------------------ */
async function callPlayAPI({txSig=null, mode="PAID"}) {
  const res = await fetch(`${CFG.API_BASE}/play`, {
    method: "POST",
    headers: {"content-type":"application/json"},
    body: JSON.stringify({
      wallet: wallet.publicKey.toBase58(),
      txSig, mode,
      pay: document.querySelector('input[name="pay"]:checked')?.value || "INPI"
    })
  });
  return await res.json();
}

/* ------------------ IPFS Utils (robust) ------------------ */
// NEW: baue vollständige URL-Liste (inkl. optionaler Proxy) für ipfs://CID/path oder rohen CID/Pfad
function ipfsCandidateUrls(ipfsPathOrHttp) {
  if (!ipfsPathOrHttp) return [];
  if (ipfsPathOrHttp.startsWith("http")) return [ipfsPathOrHttp];

  let path = ipfsPathOrHttp;
  if (path.startsWith("ipfs://")) path = path.slice(7); // CID/... 

  const urls = [];
  // Proxy zuerst (CORS-frei), wenn konfiguriert
  if (CFG.IPFS_PROXY_PREFIX) urls.push(CFG.IPFS_PROXY_PREFIX + path);
  // Dann Gateways
  for (const gw of CFG.GATEWAYS) urls.push(gw + path);
  return urls;
}

function timeout(ms) { return new Promise((_, rej) => setTimeout(()=>rej(new Error("timeout")), ms)); }

// JSON holen mit konsequentem Fallback (ohne HEAD)
async function fetchJsonRobust(ipfsPathOrHttp) {
  const urls = ipfsCandidateUrls(ipfsPathOrHttp);
  let lastErr = null;
  for (const u of urls) {
    try {
      const res = await Promise.race([fetch(u, { cache:"no-store" }), timeout(CFG.IPFS_TIMEOUT_MS)]);
      if (res.ok) return await res.json();
      lastErr = new Error(`HTTP ${res.status}`);
    } catch (e) { lastErr = e; }
  }
  throw lastErr ?? new Error("IPFS JSON nicht erreichbar");
}

// Media anzeigen: wir setzen src direkt und lauschen onerror → Fallback
function setMediaWithFallback(el, ipfsPathOrHttp, isVideo=false, posterIpfs=null) {
  const urls = ipfsCandidateUrls(ipfsPathOrHttp);
  let idx = 0;
  const tryNext = () => {
    if (idx >= urls.length) { el.removeAttribute("src"); el.style.display="none"; return; }
    const url = urls[idx++];
    if (isVideo) {
      el.src = url;
      if (posterIpfs) {
        const posters = ipfsCandidateUrls(posterIpfs);
        el.poster = posters[0];
      }
      el.onerror = tryNext;
      el.onloadeddata = () => { el.style.display="block"; };
      // Autoplay may fail silently; that’s okay.
      el.play().catch(()=>{});
    } else {
      el.src = url;
      el.onerror = tryNext;
      el.onload = () => { el.style.display="block"; };
    }
  };
  tryNext();
}

/* ------------------ Rarity (optional Anzeige) ------------------ */
async function loadRarityIfNeeded() {
  if (RARITY_CACHE.loaded) return;
  try {
    const j = await fetch(CFG.RARITY_URL, { cache:"no-store" }).then(r=>r.json());
    let counts = { Legendary:0, Epic:0, Rare:0, Common:0 };
    for (const o of j) {
      RARITY_CACHE.byId.set(o.id, o);
      counts[o.tier] = (counts[o.tier]||0)+1;
    }
    RARITY_CACHE.counts = counts;
    RARITY_CACHE.loaded = true;
    if (rarityListEl) {
      rarityListEl.innerHTML = "";
      for (const tier of ["Legendary","Epic","Rare","Common"]) {
        const li = document.createElement("li");
        li.textContent = `${tier}: ${counts[tier] ?? 0}`;
        rarityListEl.appendChild(li);
      }
    }
  } catch {}
}

/* ------------------ Helius Owner Lookup (optional) ------------------ */
// Suche Asset über Collection + Name "Pi Pyramide #<id>"
async function heliusSearchAssetById(id) {
  if (!CFG.HELIUS_API_KEY) return null;
  const url = `https://api.helius.xyz/v1/search-assets?api-key=${CFG.HELIUS_API_KEY}`;
  const body = {
    conditionType: "all",
    conditions: [
      { field: "group_key", operator: "=", value: "collection" },
      { field: "group_value", operator: "=", value: CFG.COLLECTION },
      { field: "name", operator: "=", value: CFG.COLLECTION_NAME_PREFIX + id }
    ],
    limit: 1,
    page: 1
  };
  try {
    const res = await fetch(url, { method:"POST", headers:{ "content-type":"application/json" }, body: JSON.stringify(body) });
    if (!res.ok) return null;
    const data = await res.json();
    return (data?.result?.length ? data.result[0] : null);
  } catch { return null; }
}

/* ------------------ NFT Preview ------------------ */
function hideMedia() {
  nftVideo.pause(); nftVideo.removeAttribute("src"); nftVideo.removeAttribute("poster"); nftVideo.style.display = "none";
  nftImage.removeAttribute("src"); nftImage.style.display = "none";
}
function setGridOverlay(on) { gridOverlay.style.display = on ? "block" : "none"; }
function setPixelate(on) { nftImage.classList.toggle("pixelate", on); nftVideo.classList.toggle("pixelate", on); }
if (grid16El) grid16El.onchange = () => setGridOverlay(grid16El.checked);
if (pixelateEl) pixelateEl.onchange = () => setPixelate(pixelateEl.checked);

async function fetchMetadata(id) {
  if (META_CACHE.has(id)) return META_CACHE.get(id);

  // 1) Wenn Helius da ist → on-chain URI nehmen (robuster als starre CID)
  let jsonUri = null;
  const asset = await heliusSearchAssetById(id);
  if (asset?.content?.json_uri) jsonUri = asset.content.json_uri;

  // 2) Fallback: alte feste Pinata-Struktur (nur falls jsonUri fehlt)
  if (!jsonUri) jsonUri = `ipfs://${CFG.PINATA_CID}/${id}.json`;

  const meta = await fetchJsonRobust(jsonUri);
  META_CACHE.set(id, meta);
  return meta;
}

async function renderOwnerLine(id) {
  if (!ownerLineEl) return;
  ownerLineEl.textContent = "Owner: –";
  const asset = await heliusSearchAssetById(id);
  if (!asset) { ownerLineEl.textContent = "Owner: (unbekannt / ohne Helius)"; return; }
  const owner = asset?.ownership?.owner ?? asset?.authorities?.[0]?.address ?? "(n/a)";
  ownerLineEl.textContent = `Owner: ${owner}`;
}

async function renderNFTById(id) {
  await loadRarityIfNeeded();

  hideMedia();
  metaBox.textContent = "Lade Metadaten…";
  try {
    const meta = await fetchMetadata(id);
    const name = meta.name ?? `#${id}`;
    const anim = meta.animation_url;
    const img  = meta.image;

    // Medien laden (ohne HEAD, mit Fallbackkette)
    if (anim && (anim.endsWith(".mp4") || anim.includes(".mp4") || anim.startsWith("ipfs://"))) {
      setMediaWithFallback(nftVideo, anim, true, img || null);
      setGridOverlay(grid16El?.checked); setPixelate(pixelateEl?.checked);
    } else if (img) {
      setMediaWithFallback(nftImage, img, false, null);
      setGridOverlay(grid16El?.checked); setPixelate(pixelateEl?.checked);
    } else {
      metaBox.textContent = "Keine Medienfelder gefunden.";
      return;
    }

    // Rarity (falls vorhanden)
    const r = RARITY_CACHE.byId.get(id);
    const rarityShort = r ? { tier:r.tier, axis:r.is_axis, pair:r.is_in_matching_pair, pi_eq_phi:r.pi_equals_phi } : null;

    metaBox.textContent = JSON.stringify({ id, name, has_video: !!anim, rarity: rarityShort }, null, 2);

    // Owner anzeigen (wenn Helius-Key gesetzt)
    if (CFG.HELIUS_API_KEY) renderOwnerLine(id);
  } catch (e) {
    metaBox.textContent = "Fehler beim Laden: " + (e?.message || String(e));
    hideMedia();
  }
}

// Manuelle Anzeige
if (btnShowId) {
  btnShowId.onclick = async () => {
    const v = Number(manualIdInput.value);
    if (Number.isNaN(v) || v < 0 || v > 399) return alert("Bitte eine ID zwischen 0 und 399 eingeben.");
    await renderNFTById(v);
  };
}
// Zufällige Anzeige
if (btnRandom) {
  btnRandom.onclick = async () => {
    const v = Math.floor(Math.random()*400);
    manualIdInput.value = v;
    await renderNFTById(v);
  };
}

/* ------------------ Thumbs + Pager 0..399 (4 Seiten à 100) ------------------ */
let currentPage = 0;               // 0..3
const PAGE_SIZE = 100;
const MAX_ID = 399;
const PAGES = 4;

function pageRange(p) { const start = p*PAGE_SIZE; const end = Math.min(start+PAGE_SIZE-1, MAX_ID); return {start, end}; }
function renderPageInfo() { if (pageInfo) pageInfo.textContent = `Seite ${currentPage+1}/${PAGES}`; }
function clearThumbs() { if (thumbBar) thumbBar.innerHTML = ""; }

function thumbEl(id) {
  const div = document.createElement("div");
  div.className = "thumb loading";
  div.dataset.id = String(id);
  const badge = document.createElement("div"); badge.className = "badge"; badge.textContent = "#" + id;
  const img = document.createElement("img"); img.alt = "#" + id;
  div.appendChild(img); div.appendChild(badge);
  div.onclick = () => { manualIdInput.value = id; renderNFTById(id); };
  return { div, img };
}

async function loadThumb(id) {
  if (THUMB_CACHE.has(id)) return THUMB_CACHE.get(id);
  try {
    const meta = await fetchMetadata(id);
    let url = "";
    if (meta.image) {
      // Bild-URL direkt aus Metadaten (mit Gateway/Proxy-Fallback)
      const candidates = ipfsCandidateUrls(meta.image);
      url = candidates[0];
    }
    THUMB_CACHE.set(id, url);
    return url;
  } catch { THUMB_CACHE.set(id, ""); return ""; }
}

async function renderThumbPage(p) {
  clearThumbs();
  const { start, end } = pageRange(p);
  const ids = Array.from({length: end-start+1}, (_,i)=> start+i);
  for (const id of ids) {
    const {div, img} = thumbEl(id);
    thumbBar.appendChild(div);
    (window.requestIdleCallback || setTimeout)(async () => {
      const url = await loadThumb(id);
      if (url) img.src = url;
      div.classList.remove("loading");
    }, 1);
  }
  renderPageInfo();
}
if (btnLoadThumbs) btnLoadThumbs.onclick = async () => { await renderThumbPage(currentPage); };
if (prevPage) prevPage.onclick = async () => { currentPage = (currentPage - 1 + PAGES) % PAGES; await renderThumbPage(currentPage); };
if (nextPage) nextPage.onclick = async () => { currentPage = (currentPage + 1) % PAGES; await renderThumbPage(currentPage); };
renderPageInfo();

/* ------------------ Play ------------------ */
if (btnPlay) {
  btnPlay.onclick = async () => {
    if (!wallet) return alert("Bitte erst mit Phantom verbinden.");

    linksEl.innerHTML = "";
    lastSig = null;

    try {
      const pay = document.querySelector('input[name="pay"]:checked')?.value || "INPI";
      const tx = (pay === "INPI") ? await buildInpiTx(wallet.publicKey) : await buildUsdcTx(wallet.publicKey);
      const sig = await window.solana.signAndSendTransaction(tx);
      const sigStr = sig.signature || sig; // Phantom liefert obj mit .signature

      lastSig = sigStr;

      const conn = await ensureConn();
      await conn.confirmTransaction(sigStr, "confirmed");
      const apiResp = await callPlayAPI({txSig: sigStr, mode:"PAID"});

      resultEl.textContent = JSON.stringify(apiResp.result, null, 2);
      proofEl.textContent  = JSON.stringify(apiResp.proof,  null, 2);

      // Explorer-Link
      const a = document.createElement("a");
      a.href = `https://explorer.solana.com/tx/${sigStr}?cluster=mainnet`;
      a.target = "_blank"; a.rel = "noopener";
      a.textContent = "Transaktion im Solana Explorer öffnen";
      linksEl.appendChild(a);

      // 3D-Animation deterministisch (Seed via WebCrypto)
      const seedInput = wallet.publicKey.toBase58() + (lastSig || "FREE") + (apiResp?.proof?.blockhash || "");
      const fullSeed = await sha256Hex(seedInput);
      runPiRoll({
        seed: fullSeed,
        rows: 400,
        visibleRows: 400,
        won: !!apiResp?.result?.won,
        pickedId: apiResp?.result?.id ?? null
      });

      // Auto-Preview
      if (autoPreviewEl?.checked && apiResp?.result?.won && Number.isInteger(apiResp.result.id)) {
        await renderNFTById(apiResp.result.id);
      }

      await refreshBalances();
    } catch (e) {
      console.error(e);
      resultEl.textContent = "Fehler: " + (e?.message || String(e));
    }
  };
}