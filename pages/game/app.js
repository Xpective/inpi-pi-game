// Frontend mit Phantom, API, Boost-Countdown, Explorer-Link,
// NFT-Preview (Pinata) + Profi-Extras: Thumbnail-Bar, Random-Preview, Pixelate

import { runPiRoll } from "./three-scene.js?v=1";

// @ts-ignore
import {
  Connection, PublicKey, Transaction
} from "https://cdn.jsdelivr.net/npm/@solana/web3.js@1.95.3/lib/index.iife.min.js";
// @ts-ignore
import {
  getAssociatedTokenAddress, createAssociatedTokenAccountInstruction,
  createTransferCheckedInstruction
} from "https://cdn.jsdelivr.net/npm/@solana/spl-token@0.4.8/index.iife.min.js";

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

  // Pinata / IPFS (0–100 JSON: image + animation_url=mp4)
  PINATA_CID: "bafybeibjqtwncnrsv4vtcnrqcck3bgecu3pfip7mwu4pcdenre5b7am7tu",
  GATEWAYS: [
    "https://gateway.pinata.cloud/ipfs/",
    "https://cloudflare-ipfs.com/ipfs/",
    "https://ipfs.io/ipfs/"
  ],
  IPFS_TIMEOUT_MS: 4500   // schneller Fallback
};

// ---- DOM ----
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

// Kostenanzeige
spanCost.textContent = Number(CFG.COST_USDC).toFixed(2);

let wallet = null;
let connection = null;
let lastSig = null;

// kleines Frontend-Cache
const META_CACHE = new Map(); // id -> json
const THUMB_CACHE = new Map(); // id -> url

// ---- Helpers ----
function pickRpc(){ return CFG.RPCS[Math.floor(Math.random()*CFG.RPCS.length)]; }
async function ensureConn(){ return connection ?? (connection = new Connection(pickRpc(), "confirmed")); }
async function getAta(mint, owner){ return await getAssociatedTokenAddress(new PublicKey(mint), new PublicKey(owner), false); }

async function fetchTokenBalance(mint, owner, decimals) {
  const conn = await ensureConn();
  const ata = await getAta(mint, owner);
  const info = await conn.getTokenAccountBalance(ata).catch(()=>null);
  const raw = info?.value?.amount ? BigInt(info.value.amount) : 0n;
  return { raw, ui: Number(raw) / 10**decimals };
}

async function refreshBalances() {
  if (!wallet) return;
  const [inpi, usdc] = await Promise.all([
    fetchTokenBalance(CFG.INPI_MINT, wallet.publicKey, CFG.INPI_DECIMALS),
    fetchTokenBalance(CFG.USDC_MINT, wallet.publicKey, CFG.USDC_DECIMALS),
  ]);
  spanInpi.textContent = inpi.ui.toFixed(4);
  spanUsdc.textContent = usdc.ui.toFixed(4);
}

// ---- Europe/Berlin Zeit & Boost ----
function nowBerlin() {
  const d = new Date();
  const m = d.getUTCMonth();
  const offset = (m>=2 && m<=9) ? 2 : 1; // grobe Sommerzeit
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
  if (secs === 0) {
    hintEl.textContent = "Community-Boost aktiv: +1.00% Chance";
    boostTimerEl.textContent = "Jetzt!";
  } else {
    hintEl.textContent = "Tipp: Zur vollen Stunde +1.00% Boost";
    boostTimerEl.textContent = "Nächster Boost in " + formatMMSS(secs);
  }
}
setInterval(updateBoostUI, 1000);
updateBoostUI();

// ---- Wallet ----
btnConnect.onclick = async () => {
  if (!window?.solana?.isPhantom) {
    alert("Phantom Wallet nicht gefunden. Bitte Phantom installieren.");
    return;
  }
  const resp = await window.solana.connect();
  wallet = resp;
  btnConnect.textContent = `Verbunden: ${wallet.publicKey.toBase58().slice(0,6)}…`;
  await ensureConn();
  await refreshBalances();
};

// ---- Zahlungen ----
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

// ---- API ----
async function callPlayAPI({txSig=null, mode="PAID"}) {
  const res = await fetch(`${CFG.API_BASE}/play`, {
    method: "POST",
    headers: {"content-type":"application/json"},
    body: JSON.stringify({
      wallet: wallet.publicKey.toBase58(),
      txSig, mode, pay: document.querySelector('input[name="pay"]:checked').value
    })
  });
  return await res.json();
}

// ---- IPFS Utils (mit Fallbacks & Timeout) ----
function toGatewayUrls(path) {
  const p = path.startsWith("http") ? path : (path.startsWith("ipfs://") ? path.replace("ipfs://","") : path);
  return p.startsWith("http") ? [p] : CFG.GATEWAYS.map(gw => gw + p);
}
function timeout(ms) {
  return new Promise((_, rej) => setTimeout(()=>rej(new Error("timeout")), ms));
}
async function fetchJsonWithFallbacks(path) {
  const urls = toGatewayUrls(path);
  for (const u of urls) {
    try {
      const res = await Promise.race([fetch(u, {cache:"no-store"}), timeout(CFG.IPFS_TIMEOUT_MS)]);
      if (res.ok) return await res.json();
    } catch {}
  }
  throw new Error("IPFS JSON nicht erreichbar");
}
async function headOk(url) {
  try {
    const res = await Promise.race([fetch(url, { method:"HEAD" }), timeout(2500)]);
    return res.ok;
  } catch { return false; }
}

// ---- NFT Preview ----
function hideMedia() {
  nftVideo.pause();
  nftVideo.removeAttribute("src"); nftVideo.removeAttribute("poster");
  nftVideo.style.display = "none";
  nftImage.removeAttribute("src");
  nftImage.style.display = "none";
}
function setGridOverlay(on) { gridOverlay.style.display = on ? "block" : "none"; }
function setPixelate(on) {
  nftImage.classList.toggle("pixelate", on);
  nftVideo.classList.toggle("pixelate", on);
}
grid16El.onchange = () => setGridOverlay(grid16El.checked);
pixelateEl.onchange = () => setPixelate(pixelateEl.checked);

async function fetchMetadata(id) {
  if (META_CACHE.has(id)) return META_CACHE.get(id);
  const meta = await fetchJsonWithFallbacks(`${CFG.PINATA_CID}/${id}.json`);
  META_CACHE.set(id, meta);
  return meta;
}

async function renderNFTById(id) {
  hideMedia();
  metaBox.textContent = "Lade Metadaten…";
  try {
    const meta = await fetchMetadata(id);
    const name = meta.name ?? `#${id}`;
    const anim = meta.animation_url;
    const img  = meta.image;

    // Video bevorzugen, Bild fallback
    if (anim && (anim.endsWith(".mp4") || anim.includes(".mp4"))) {
      const animPath = anim.startsWith("ipfs://") ? anim.replace("ipfs://","") : anim;
      const candidates = toGatewayUrls(animPath);
      let chosen = null;
      for (const u of candidates) {
        if (await headOk(u)) { chosen = u; break; }
      }
      nftVideo.src = chosen || candidates[0];
      if (img) {
        const imgPath = img.startsWith("ipfs://") ? img.replace("ipfs://","") : img;
        nftVideo.poster = toGatewayUrls(imgPath)[0];
      }
      nftVideo.style.display = "block";
      setGridOverlay(grid16El.checked);
      setPixelate(pixelateEl.checked);
      await nftVideo.play().catch(()=>{});
    } else if (img) {
      const imgPath = img.startsWith("ipfs://") ? img.replace("ipfs://","") : img;
      nftImage.src = toGatewayUrls(imgPath)[0];
      nftImage.style.display = "block";
      setGridOverlay(grid16El.checked);
      setPixelate(pixelateEl.checked);
    } else {
      metaBox.textContent = "Keine Medienfelder gefunden.";
      return;
    }

    metaBox.textContent = JSON.stringify({ id, name, has_video: !!anim }, null, 2);
  } catch (e) {
    metaBox.textContent = "Fehler beim Laden: " + (e?.message || String(e));
    hideMedia();
  }
}

// Manuelle Anzeige
btnShowId.onclick = async () => {
  const v = Number(manualIdInput.value);
  if (Number.isNaN(v) || v < 0 || v > 100) return alert("Bitte eine ID zwischen 0 und 100 eingeben.");
  await renderNFTById(v);
};
// Zufällige Anzeige
btnRandom.onclick = async () => {
  const v = Math.floor(Math.random()*101);
  manualIdInput.value = v;
  await renderNFTById(v);
};

// Thumbnail-Bar (Lazy)
function thumbEl(id) {
  const div = document.createElement("div");
  div.className = "thumb loading";
  div.dataset.id = String(id);
  const badge = document.createElement("div");
  badge.className = "badge";
  badge.textContent = "#" + id;
  const img = document.createElement("img");
  img.alt = "#" + id;
  div.appendChild(img);
  div.appendChild(badge);
  div.onclick = () => { manualIdInput.value = id; renderNFTById(id); };
  return { div, img };
}

async function loadThumb(id) {
  if (THUMB_CACHE.has(id)) return THUMB_CACHE.get(id);
  try {
    const meta = await fetchMetadata(id);
    let thumbUrl = null;
    if (meta.image) {
      const path = meta.image.startsWith("ipfs://") ? meta.image.replace("ipfs://","") : meta.image;
      thumbUrl = toGatewayUrls(path)[0];
    } else if (meta.animation_url) {
      // kein echtes Thumbnail — nimm Video-Poster wenn vorhanden, sonst nix
      thumbUrl = ""; // leer => lassen wir Image leer
    }
    THUMB_CACHE.set(id, thumbUrl || "");
    return thumbUrl || "";
  } catch {
    THUMB_CACHE.set(id, "");
    return "";
  }
}

btnLoadThumbs.onclick = async () => {
  if (thumbBar.childElementCount) return; // schon geladen
  // 0..100
  const ids = Array.from({length:101}, (_,i)=>i);
  for (const id of ids) {
    const {div, img} = thumbEl(id);
    thumbBar.appendChild(div);
    // lazy load
    requestIdleCallback(async () => {
      const url = await loadThumb(id);
      if (url) img.src = url;
      div.classList.remove("loading");
    }, { timeout: 1200 });
  }
};

// ---- Play ----
btnPlay.onclick = async () => {
  if (!wallet) return alert("Bitte erst mit Phantom verbinden.");

  linksEl.innerHTML = "";
  lastSig = null;

  try {
    const pay = document.querySelector('input[name="pay"]:checked').value;
    const tx = (pay === "INPI")
      ? await buildInpiTx(wallet.publicKey)
      : await buildUsdcTx(wallet.publicKey);

    const sig = await window.solana.signAndSendTransaction(tx);
    const sigStr = sig.signature;
    lastSig = sigStr;

    // Confirm, dann API
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

    // 3D-Animation deterministisch
    const fullSeed = sha256(wallet.publicKey.toBase58() + (lastSig || "FREE") + (apiResp?.proof?.blockhash || ""));
    runPiRoll({ seed: fullSeed, rows: 100, visibleRows: 40, won: !!apiResp?.result?.won, pickedId: apiResp?.result?.id ?? null });

    // Auto-Preview
    if (autoPreviewEl.checked && apiResp?.result?.won && Number.isInteger(apiResp.result.id)) {
      await renderNFTById(apiResp.result.id);
    }

    await refreshBalances();
  } catch (e) {
    console.error(e);
    resultEl.textContent = "Fehler: " + (e?.message || String(e));
  }
};