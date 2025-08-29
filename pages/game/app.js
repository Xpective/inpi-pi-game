// Minimal-Frontend (Phantom + Tx + API-Ping)

// Web3 & SPL-Token via CDN
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
  // RPCs (einen eigenen Proxy kannst du später ergänzen)
  RPCS: ["https://api.mainnet-beta.solana.com"],
  // Offizielle Mints & Owner
  INPI_MINT: "GBfEVjkSn3KSmRnqe83Kb8c42DsxkJmiDCb4AbNYBYt1",
  USDC_MINT: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  TREASURY_OWNER: "GEFoNLncuhh4nH99GKvVEUxe59SGe74dbLG7UUtfHrCp", // INPI 80%
  INCINERATOR_OWNER: "1nc1nerator11111111111111111111111111111111", // INPI 20% Burn
  LP_OWNER: "GEFoNLncuhh4nH99GKvVEUxe59SGe74dbLG7UUtfHrCp", // USDC → LP
  // Kosten
  COST_INPI: 2000,   // 2000 INPI
  COST_USDC: 1,      // 1.00 USDC
  // API
  API_BASE: "https://api.inpinity.online/game",
  // Anzeige
  INPI_DECIMALS: 9,
  USDC_DECIMALS: 6
};

const $ = (s)=>document.querySelector(s);
const btnConnect = $("#btnConnect");
const btnPlay    = $("#btnPlay");
const spanInpi   = $("#balInpi");
const spanUsdc   = $("#balUsdc");
const spanCost   = $("#usdcCost");
const resultEl   = $("#result");
const proofEl    = $("#proof");
const hintEl     = $("#hint");

spanCost.textContent = Number(CFG.COST_USDC).toFixed(2);

let wallet = null;
let connection = null;

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

function nowBerlin() {
  const d = new Date();
  const m = d.getUTCMonth();
  const offset = (m>=2 && m<=9) ? 2 : 1; // Sommerzeit grob
  return new Date(d.getTime() + offset*3600*1000);
}
function communityBoostActive(){ return nowBerlin().getMinutes() === 0; }

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
  hintEl.textContent = communityBoostActive()
    ? "Community-Boost aktiv: +1.00% Chance"
    : "Tipp: Zur vollen Stunde +1.00% Boost";
};

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

btnPlay.onclick = async () => {
  if (!wallet) return alert("Bitte erst mit Phantom verbinden.");
  const pay = document.querySelector('input[name="pay"]:checked').value;

  // Gratis-Run wird serverseitig anhand deines Loss-Streaks erzwungen.
  // Client versucht nur „FREE“, Server bestätigt/ablehnt.
  const tryFree = false; // UI-neutral, nur Server entscheidet

  try {
    let apiResp;
    if (tryFree) {
      apiResp = await callPlayAPI({txSig:null, mode:"FREE"});
    } else {
      const tx = pay === "INPI"
        ? await buildInpiTx(wallet.publicKey)
        : await buildUsdcTx(wallet.publicKey);
      const sig = await window.solana.signAndSendTransaction(tx);
      const conn = await ensureConn();
      await conn.confirmTransaction(sig.signature, "confirmed");
      apiResp = await callPlayAPI({txSig: sig.signature, mode:"PAID"});
    }

    resultEl.textContent = JSON.stringify(apiResp.result, null, 2);
    proofEl.textContent  = JSON.stringify(apiResp.proof,  null, 2);
    await refreshBalances();
  } catch (e) {
    console.error(e);
    resultEl.textContent = "Fehler: " + (e?.message || String(e));
  }
};