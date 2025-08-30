// Frontend mit Phantom, API, Boost-Countdown, Explorer-Link,
// NFT-Preview (robustes IPFS) + Thumbs (0–399) + Pixelate
// Helius Owner-Check optional, USDC-Balance-Fix, RPC-Fallback, Burn-Fix

import { runPiRoll } from "./three-scene.js?v=1";

/* ---------- Solana libs (ESM) ---------- */
import {
  Connection, PublicKey, Transaction
} from "https://esm.sh/@solana/web3.js@1.95.3?bundle&target=es2020";
import {
  getAssociatedTokenAddress,
  createAssociatedTokenAccountInstruction,
  createTransferCheckedInstruction
} from "https://esm.sh/@solana/spl-token@0.4.8?bundle&target=es2020";

/* ---------- Config ---------- */
const CFG = {
  // RPCs: 1) Helius (falls KEY gesetzt) 2) Fallbacks (öffentliche Provider optional)
  HELIUS_API_KEY: "", // <— trage deinen Helius Key ein; leer = kein Helius
  RPCS: [
    // wird zur Laufzeit um Helius ergänzt, wenn KEY gesetzt
    "https://api.mainnet-beta.solana.com" // kann 403 geben → wir rotieren
  ],

  INPI_MINT: "GBfEVjkSn3KSmRnqe83Kb8c42DsxkJmiDCb4AbNYBYt1",
  USDC_MINT: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",

  TREASURY_OWNER: "GEFoNLncuhh4nH99GKvVEUxe59SGe74dbLG7UUtfHrCp", // INPI 80%
  INCINERATOR_OWNER: "1nc1nerator11111111111111111111111111111111",  // INPI 20% Burn (owner off-curve!)
  LP_OWNER: "GEFoNLncuhh4nH99GKvVEUxe59SGe74dbLG7UUtfHrCp",          // USDC → LP

  COST_INPI: 2000,
  COST_USDC: 1,
  INPI_DECIMALS: 9,
  USDC_DECIMALS: 6,

  API_BASE: "https://api.inpinity.online/game",

  // IPFS: **Proxy deaktiviert** bis die Worker-Route existiert. Nur Gateways nutzen.
  PINATA_CID: "bafybeibjqtwncnrsv4vtcnrqcck3bgecu3pfip7mwu4pcdenre5b7am7tu",
  GATEWAYS: [
    "https://nftstorage.link/ipfs/",
    "https://dweb.link/ipfs/",
    "https://cloudflare-ipfs.com/ipfs/",
    "https://ipfs.io/ipfs/",
    "https://gateway.pinata.cloud/ipfs/"
  ],
  IPFS_PROXY_PREFIX: "", // war: "https://api.inpinity.online/game/ipfs/" → erstmal leer lassen
  IPFS_TIMEOUT_MS: 5000,

  // Rarity JSON
  RARITY_URL: "https://inpinity.online/game/data/pi_phi_table.json",

  // Helius DAS (Owner/Asset Lookup)
  COLLECTION: "6xvwKXMUGfkqhs1f3ZN3KkrdvLh2vF3tX1pqLo9aYPrQ",
  COLLECTION_NAME_PREFIX: "Pi Pyramide #"
};

// Helius RPC als bevorzugten Endpoint vorschalten (verhindert 403)
if (CFG.HELIUS_API_KEY) {
  CFG.RPCS.unshift(`https://mainnet.helius-rpc.com/?api-key=${CFG.HELIUS_API_KEY}`);
}

/* ---------- SHA-256 ---------- */
async function sha256Hex(str){
  const data = new TextEncoder().encode(str);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hash)).map(b=>b.toString(16).padStart(2,"0")).join("");
}

/* ---------- DOM ---------- */
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
const rarityListEl  = $("#rarityList");
const ownerLineEl   = $("#ownerLine");

if (spanCost) spanCost.textContent = Number(CFG.COST_USDC).toFixed(2);

let wallet = null;
let connection = null;
let lastSig = null;

const META_CACHE = new Map();
const THUMB_CACHE = new Map();
const RARITY_CACHE = { loaded:false, byId:new Map(), counts:null };

/* ---------- RPC-Rotation + Connection ---------- */
let rpcIdx = 0;
function pickRpc(){ rpcIdx = (rpcIdx+1) % CFG.RPCS.length; return CFG.RPCS[rpcIdx]; }

async function ensureConn() {
  if (connection) return connection;
  // versuche in Reihenfolge, bis einer nicht 403 liefert
  for (let i=0;i<CFG.RPCS.length;i++){
    const url = CFG.RPCS[i];
    try {
      const conn = new Connection(url, "confirmed");
      // kleine Probe: getEpochInfo
      await conn.getEpochInfo(); // kann 403 werfen
      connection = conn;
      return connection;
    } catch (e) {
      // weiter zum nächsten RPC
    }
  }
  // letzter Versuch: aktueller pick
  connection = new Connection(pickRpc(), "confirmed");
  return connection;
}

/* ---------- Token-Balances (summiert alle Accounts) ---------- */
async function fetchTokenBalanceSum(mint, owner, decimals) {
  const tryRPC = async () => {
    const conn = await ensureConn();
    return await conn.getParsedTokenAccountsByOwner(new PublicKey(owner), { mint: new PublicKey(mint) });
  };
  let resp = null;
  try {
    resp = await tryRPC();
  } catch (e) {
    // 403/Netz → auf nächsten RPC wechseln & retry
    connection = null;
    resp = await tryRPC().catch(()=>null);
  }
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

/* ---------- Boost (Europe/Berlin) ---------- */
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

/* ---------- Wallet ---------- */
if (btnConnect) {
  btnConnect.onclick = async () => {
    if (!window?.solana?.isPhantom) return alert("Phantom Wallet nicht gefunden. Bitte Phantom installieren.");
    const resp = await window.solana.connect();
    wallet = resp;
    btnConnect.textContent = `Verbunden: ${wallet.publicKey.toBase58().slice(0,6)}…`;
    connection = null; // Connection neu aufbauen (falls RPC gewechselt werden muss)
    await ensureConn();
    await refreshBalances();
  };
}

/* ---------- Helpers ---------- */
async function getAtaSafe(mint, owner, allowOffCurve=false){
  return await getAssociatedTokenAddress(new PublicKey(mint), new PublicKey(owner), allowOffCurve);
}

/* ---------- Zahlungen ---------- */
async function buildInpiTx(payer) {
  const tryBuild = async () => {
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

    const ataPayer = await getAtaSafe(mint, payerPk);
    const ataTreas = await getAtaSafe(mint, treasOwner);
    // !!! off-curve für incinerator:
    const ataBurn  = await getAtaSafe(mint, burnOwner, true);

    // prüfe Ziel-ATAs, erstelle falls fehlen (treasury + burn)
    const infos = await conn.getMultipleAccountsInfo([ataTreas, ataBurn]).catch(()=>[null,null]);
    if (!infos?.[0]) ix.push(createAssociatedTokenAccountInstruction(payerPk, ataTreas, treasOwner, mint));
    if (!infos?.[1]) ix.push(createAssociatedTokenAccountInstruction(payerPk, ataBurn,  burnOwner,  mint));

    ix.push(createTransferCheckedInstruction(ataPayer, mint, ataBurn,  payerPk, Number(amtBurn),  decimals));
    ix.push(createTransferCheckedInstruction(ataPayer, mint, ataTreas, payerPk, Number(amtTreas), decimals));

    const tx = new Transaction().add(...ix);
    tx.feePayer = payerPk;
    tx.recentBlockhash = (await conn.getLatestBlockhash("finalized")).blockhash;
    return tx;
  };
  try {
    return await tryBuild();
  } catch (e) {
    // 403 etc → andere RPC
    connection = null;
    return await tryBuild();
  }
}

async function buildUsdcTx(payer) {
  const tryBuild = async () => {
    const conn = await ensureConn();
    const mint = new PublicKey(CFG.USDC_MINT);
    const decimals = CFG.USDC_DECIMALS;
    const amount = BigInt(CFG.COST_USDC * 10**decimals); // 1.00 USDC

    const ix = [];
    const payerPk = new PublicKey(payer);
    const lpOwner = new PublicKey(CFG.LP_OWNER);

    const ataPayer = await getAtaSafe(mint, payerPk);
    const ataLp    = await getAtaSafe(mint, lpOwner);

    let info = null;
    try { info = await conn.getAccountInfo(ataLp); }
    catch { connection = null; const c2 = await ensureConn(); info = await c2.getAccountInfo(ataLp).catch(()=>null); }

    if (!info) ix.push(createAssociatedTokenAccountInstruction(payerPk, ataLp, lpOwner, mint));
    ix.push(createTransferCheckedInstruction(ataPayer, mint, ataLp, payerPk, Number(amount), decimals));

    const tx = new Transaction().add(...ix);
    tx.feePayer = payerPk;
    tx.recentBlockhash = (await conn.getLatestBlockhash("finalized")).blockhash;
    return tx;
  };
  try {
    return await tryBuild();
  } catch (e) {
    connection = null;
    return await tryBuild();
  }
}

/* ---------- API ---------- */
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

/* ---------- IPFS Utils (robust, ohne Proxy) ---------- */
function ipfsCandidateUrls(ipfsPathOrHttp) {
  if (!ipfsPathOrHttp) return [];
  if (ipfsPathOrHttp.startsWith("http")) return [ipfsPathOrHttp];

  let path = ipfsPathOrHttp;
  if (path.startsWith("ipfs://")) path = path.slice(7); // CID/...

  const urls = [];
  // Proxy deaktiviert – nur Gateways nutzen
  for (const gw of CFG.GATEWAYS) urls.push(gw + path);
  return urls;
}
function timeout(ms) { return new Promise((_, rej) => setTimeout(()=>rej(new Error("timeout")), ms)); }
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
      el.play?.().catch(()=>{});
    } else {
      el.src = url;
      el.onerror = tryNext;
      el.onload = () => { el.style.display="block"; };
    }
  };
  tryNext();
}

/* ---------- Rarity ---------- */
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

/* ---------- Helius Owner Lookup (JSON-RPC korrekt) ---------- */
async function heliusSearchAssetById(id) {
  if (!CFG.HELIUS_API_KEY) return null;
  const url = `https://mainnet.helius-rpc.com/?api-key=${CFG.HELIUS_API_KEY}`;
  const body = {
    jsonrpc: "2.0",
    id: "search-by-name",
    method: "searchAssets",
    params: {
      name: CFG.COLLECTION_NAME_PREFIX + id,
      groupKey: "collection",
      groupValue: CFG.COLLECTION,
      page: 1,
      limit: 1
    }
  };
  try {
    const res = await fetch(url, { method:"POST", headers:{ "content-type":"application/json" }, body: JSON.stringify(body) });
    if (!res.ok) return null;
    const data = await res.json();
    const items = data?.result?.items ?? data?.assets?.items ?? [];
    return items.length ? items[0] : null;
  } catch { return null; }
}

/* ---------- NFT Preview ---------- */
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

  // 1) Helius → json_uri bevorzugt
  let jsonUri = null;
  const asset = await heliusSearchAssetById(id);
  if (asset?.content?.json_uri) jsonUri = asset.content.json_uri;

  // 2) Fallback: feste Pinata-Struktur
  if (!jsonUri) jsonUri = `ipfs://${CFG.PINATA_CID}/${id}.json`;

  const meta = await fetchJsonRobust(jsonUri);
  META_CACHE.set(id, meta);
  return meta;
}

async function renderOwnerLine(id) {
  if (!ownerLineEl) return;
  ownerLineEl.textContent = "Owner: –";
  const asset = await heliusSearchAssetById(id);
  if (!asset) { ownerLineEl.textContent = "Owner: (unbekannt / Helius aus)"; return; }
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

    if (anim && (anim.endsWith(".mp4") || anim.includes(".mp4") || anim.startsWith("ipfs://") || anim.startsWith("http"))) {
      setMediaWithFallback(nftVideo, anim, true, img || null);
      setGridOverlay(grid16El?.checked); setPixelate(pixelateEl?.checked);
    } else if (img) {
      setMediaWithFallback(nftImage, img, false, null);
      setGridOverlay(grid16El?.checked); setPixelate(pixelateEl?.checked);
    } else {
      metaBox.textContent = "Keine Medienfelder gefunden.";
      return;
    }

    const r = RARITY_CACHE.byId.get(id);
    const rarityShort = r ? { tier:r.tier, axis:r.is_axis, pair:r.is_in_matching_pair, pi_eq_phi:r.pi_equals_phi } : null;
    metaBox.textContent = JSON.stringify({ id, name, has_video: !!anim, rarity: rarityShort }, null, 2);

    if (CFG.HELIUS_API_KEY) renderOwnerLine(id);
  } catch (e) {
    metaBox.textContent = "Fehler beim Laden: " + (e?.message || String(e));
    hideMedia();
  }
}

/* ---------- Manuelle/Zufällige Anzeige ---------- */
if (btnShowId) {
  btnShowId.onclick = async () => {
    const v = Number(manualIdInput.value);
    if (Number.isNaN(v) || v < 0 || v > 399) return alert("Bitte eine ID zwischen 0 und 399 eingeben.");
    await renderNFTById(v);
  };
}
if (btnRandom) {
  btnRandom.onclick = async () => {
    const v = Math.floor(Math.random()*400);
    manualIdInput.value = v;
    await renderNFTById(v);
  };
}

/* ---------- Thumbs + Pager ---------- */
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

/* ---------- Play ---------- */
if (btnPlay) {
  btnPlay.onclick = async () => {
    if (!wallet) return alert("Bitte erst mit Phantom verbinden.");

    linksEl.innerHTML = "";
    lastSig = null;

    try {
      const pay = document.querySelector('input[name="pay"]:checked')?.value || "INPI";
      const tx = (pay === "INPI") ? await buildInpiTx(wallet.publicKey) : await buildUsdcTx(wallet.publicKey);
      const sig = await window.solana.signAndSendTransaction(tx);
      const sigStr = sig.signature || sig;

      lastSig = sigStr;

      const conn = await ensureConn();
      await conn.confirmTransaction(sigStr, "confirmed");
      const apiResp = await callPlayAPI({txSig: sigStr, mode:"PAID"});

      resultEl.textContent = JSON.stringify(apiResp.result, null, 2);
      proofEl.textContent  = JSON.stringify(apiResp.proof,  null,  2);

      const a = document.createElement("a");
      a.href = `https://explorer.solana.com/tx/${sigStr}?cluster=mainnet`;
      a.target = "_blank"; a.rel = "noopener";
      a.textContent = "Transaktion im Solana Explorer öffnen";
      linksEl.appendChild(a);

      const seedInput = wallet.publicKey.toBase58() + (lastSig || "FREE") + (apiResp?.proof?.blockhash || "");
      const fullSeed = await sha256Hex(seedInput);
      runPiRoll({ seed: fullSeed, rows: 400, visibleRows: 400, won: !!apiResp?.result?.won, pickedId: apiResp?.result?.id ?? null });

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