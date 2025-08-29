// Frontend mit Phantom, API, Boost-Countdown, Explorer-Link, NFT-Preview (Pinata)

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

  COST_INPI: 2000,    // 2000 INPI
  COST_USDC: 1,       // 1.00 USDC

  API_BASE: "https://api.inpinity.online/game",

  INPI_DECIMALS: 9,
  USDC_DECIMALS: 6,

  // <<<<<< Pinata / IPFS – deine 0–100 JSONs
  // Beispiel-Struktur angenommen: <CID>/<id>.json mit Feldern image, animation_url
  PINATA_CID: "bafybeibjqtwncnrsv4vtcnrqcck3bgecu3pfip7mwu4pcdenre5b7am7tu",
  // mehrere Gateways – try in Reihenfolge:
  GATEWAYS: [
    "https://gateway.pinata.cloud/ipfs/",
    "https://cloudflare-ipfs.com/ipfs/",
    "https://ipfs.io/ipfs/"
  ]
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
const btnShowId     = $("#btnShowId");
const manualIdInput = $("#manualId");
const nftVideo      = $("#nftVideo");
const nftImage      = $("#nftImage");
const gridOverlay   = $("#gridOverlay");
const metaBox       = $("#meta");

// Kostenanzeige
spanCost.textContent = Number(CFG.COST_USDC).toFixed(2);

let wallet = null;
let connection = null;
let lastSig = null;

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

// ---- Wallet Connect ----
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

// ---- Zahlungen bauen ----
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

// ---- IPFS Helper ----
function ipfsUrl(path) {
  for (const gw of CFG.GATEWAYS) {
    // erste funktionierende wird im fetchMetadata getestet
    return gw + path; // wir nutzen testweise die erste; Fallbacks versuchen wir sequenziell im fetch
  }
  return "https://ipfs.io/ipfs/" + path;
}

async function fetchWithFallbacks(paths) {
  // paths = [ "CID/x.json", ... ] oder vollqualifizierte URLs
  const urls = [];
  for (const p of paths) {
    if (p.startsWith("http")) urls.push(p);
    else for (const gw of CFG.GATEWAYS) urls.push(gw + p);
  }
  let lastErr;
  for (const u of urls) {
    try {
      const res = await fetch(u, { cache: "no-store" });
      if (res.ok) return await res.json();
      lastErr = new Error(`HTTP ${res.status}`);
    } catch (e) { lastErr = e; }
  }
  throw lastErr || new Error("IPFS-Fetch failed");
}

async function fetchMetadata(id) {
  // Annahme: <CID>/<id>.json
  const path = `${CFG.PINATA_CID}/${id}.json`;
  return await fetchWithFallbacks([path]);
}

function hideMedia() {
  nftVideo.pause();
  nftVideo.removeAttribute("src");
  nftVideo.style.display = "none";
  nftImage.removeAttribute("src");
  nftImage.style.display = "none";
}

function setGridOverlay(on) {
  gridOverlay.style.display = on ? "block" : "none";
}

async function renderNFTById(id) {
  hideMedia();
  metaBox.textContent = "Lade Metadaten…";
  try {
    const meta = await fetchMetadata(id);
    // gängige Felder: name, description, image, animation_url
    const name = meta.name ?? `#${id}`;
    const anim = meta.animation_url;
    const img  = meta.image;

    if (anim && (anim.endsWith(".mp4") || anim.includes(".mp4"))) {
      // Video bevorzugt
      // animation_url kann ipfs://CID/... sein → normalisieren
      const animPath = anim.startsWith("ipfs://") ? anim.replace("ipfs://", "") : anim;
      nftVideo.src = animPath.startsWith("http") ? animPath : ipfsUrl(animPath);
      if (img) {
        const imgPath = img.startsWith("ipfs://") ? img.replace("ipfs://", "") : img;
        nftVideo.poster = imgPath.startsWith("http") ? imgPath : ipfsUrl(imgPath);
      }
      nftVideo.style.display = "block";
      await nftVideo.play().catch(()=>{}); // Autoplay evtl. blockiert, Controls vorhanden
    } else if (img) {
      const imgPath = img.startsWith("ipfs://") ? img.replace("ipfs://", "") : img;
      nftImage.src = imgPath.startsWith("http") ? imgPath : ipfsUrl(imgPath);
      nftImage.style.display = "block";
    } else {
      metaBox.textContent = "Keine Medienfelder gefunden.";
      return;
    }

    metaBox.textContent = JSON.stringify({
      id,
      name,
      has_video: !!anim,
      image: img || null
    }, null, 2);

    setGridOverlay(grid16El.checked);
  } catch (e) {
    metaBox.textContent = "Fehler beim Laden: " + (e?.message || String(e));
    hideMedia();
  }
}

btnShowId.onclick = async () => {
  const v = Number(manualIdInput.value);
  if (Number.isNaN(v) || v < 0 || v > 100) {
    alert("Bitte eine ID zwischen 0 und 100 eingeben.");
    return;
  }
  await renderNFTById(v);
};
grid16El.onchange = () => setGridOverlay(grid16El.checked);

// ---- Play ----
btnPlay.onclick = async () => {
  if (!wallet) return alert("Bitte erst mit Phantom verbinden.");
  const pay = document.querySelector('input[name="pay"]:checked').value;

  linksEl.innerHTML = "";
  lastSig = null;

  try {
    let apiResp, sigStr = null;

    const tx = (pay === "INPI")
      ? await buildInpiTx(wallet.publicKey)
      : await buildUsdcTx(wallet.publicKey);

    const sig = await window.solana.signAndSendTransaction(tx);
    sigStr = sig.signature;
    lastSig = sigStr;

    // Confirm, dann API anpingen
    const conn = await ensureConn();
    await conn.confirmTransaction(sigStr, "confirmed");
    apiResp = await callPlayAPI({txSig: sigStr, mode:"PAID"});

    // Ergebnis anzeigen
    resultEl.textContent = JSON.stringify(apiResp.result, null, 2);
    proofEl.textContent  = JSON.stringify(apiResp.proof,  null, 2);

    // Explorer-Link
    if (sigStr) {
      const a = document.createElement("a");
      a.href = `https://explorer.solana.com/tx/${sigStr}?cluster=mainnet`;
      a.target = "_blank";
      a.rel = "noopener";
      a.textContent = "Transaktion im Solana Explorer öffnen";
      linksEl.appendChild(a);
    }

    // 3D-Animation deterministisch starten
    const fullSeed = sha256(wallet.publicKey.toBase58() + (lastSig || "FREE") + (apiResp?.proof?.blockhash || ""));
    runPiRoll({
      seed: fullSeed,
      rows: 100,
      visibleRows: 40,
      won: !!apiResp?.result?.won,
      pickedId: apiResp?.result?.id ?? null
    });

    // Automatische NFT-Vorschau bei Gewinn
    if (autoPreviewEl.checked && apiResp?.result?.won && typeof apiResp.result.id === "number") {
      await renderNFTById(apiResp.result.id);
    }

    await refreshBalances();
  } catch (e) {
    console.error(e);
    resultEl.textContent = "Fehler: " + (e?.message || String(e));
  }
};