#!/usr/bin/env node
/**
 * BSV Post — Write permanent messages on the BSV blockchain
 * Uses OP_FALSE OP_RETURN data carrier. Costs ~200-300 sats per post.
 * Reads wallet from ~/.openclaw/bsv-wallet.json (shared with bsv skill)
 */

const fs = require('fs');
const path = require('path');
const https = require('https');

const WALLET_PATH = path.join(process.env.HOME, '.openclaw', 'bsv-wallet.json');
const WOC_BASE = 'https://api.whatsonchain.com/v1/bsv/main';
const SAT_PER_BSV = 1e8;
const FEE_RATE = 0.005; // ~1 sat per tx under 1KB (BSV miner policy, not 1 sat/byte)

// --- bsv loader (shared with wallet skill) ---

function loadBsv() {
  try {
    return require('bsv');
  } catch {
    // Try wallet skill's node_modules first
    const walletSkillDir = path.join(__dirname, '..', '..', 'bsv-skill');
    if (fs.existsSync(path.join(walletSkillDir, 'node_modules', 'bsv'))) {
      return require(path.join(walletSkillDir, 'node_modules', 'bsv'));
    }
    // Install locally
    const { execSync } = require('child_process');
    const skillDir = path.join(__dirname, '..');
    if (!fs.existsSync(path.join(skillDir, 'node_modules', 'bsv'))) {
      console.error('Installing bsv package...');
      execSync('npm install bsv@2 --save --no-fund --no-audit', { cwd: skillDir, stdio: 'inherit' });
    }
    return require(path.join(skillDir, 'node_modules', 'bsv'));
  }
}

// --- HTTP ---

function httpGet(urlStr) {
  return new Promise((resolve, reject) => {
    https.get(urlStr, { headers: { 'User-Agent': 'openclaw-bsv-post/1.0' } }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        if (res.statusCode >= 400) return reject(new Error(`HTTP ${res.statusCode}: ${data}`));
        try { resolve(JSON.parse(data)); } catch { resolve(data); }
      });
    }).on('error', reject);
  });
}

function httpPost(urlStr, body) {
  const url = new URL(urlStr);
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = https.request({
      hostname: url.hostname, path: url.pathname,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        if (res.statusCode >= 400) return reject(new Error(`HTTP ${res.statusCode}: ${data}`));
        try { resolve(JSON.parse(data)); } catch { resolve(data); }
      });
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

// --- Wallet ---

function loadWallet() {
  if (!fs.existsSync(WALLET_PATH)) {
    console.error('No wallet found. Install the BSV wallet skill and run: node wallet.cjs init');
    process.exit(1);
  }
  return JSON.parse(fs.readFileSync(WALLET_PATH, 'utf8'));
}

// --- Post ---

async function cmdPost(text) {
  if (!text) {
    console.error('Usage: node post.cjs "your message here"');
    console.error('       node post.cjs --hex 48656c6c6f');
    process.exit(1);
  }

  // Parse --hex flag
  let dataBuffer;
  if (text === '--hex' && process.argv[4]) {
    dataBuffer = Buffer.from(process.argv[4], 'hex');
    if (dataBuffer.length > 100000) {
      console.error('Data too large (max 100KB). BSV accepts larger but keep it reasonable.');
      process.exit(1);
    }
  } else {
    // Join all args as text
    const msg = process.argv.slice(2).join(' ');
    if (msg.length > 100000) {
      console.error('Message too large (max 100KB).');
      process.exit(1);
    }
    dataBuffer = Buffer.from(msg, 'utf8');
  }

  const bsv = loadBsv();
  const w = loadWallet();

  // Fetch UTXOs
  const utxos = await httpGet(`${WOC_BASE}/address/${w.address}/unspent`);
  if (!utxos.length) {
    console.error('No UTXOs (zero balance). Claim from faucet or receive BSV first.');
    process.exit(1);
  }

  // Sort largest first
  utxos.sort((a, b) => b.value - a.value);

  // Build OP_RETURN script: OP_FALSE OP_RETURN <data>
  const script = new bsv.Script();
  script.writeOpCode(bsv.OpCode.OP_FALSE);
  script.writeOpCode(bsv.OpCode.OP_RETURN);
  script.writeBuffer(dataBuffer);

  // BSV miners accept ~1 sat total for txs under 1KB
  // Fee = max(1, ceil(size_bytes / 1000)) sats
  function calcFee(numInputs, dataLen) {
    const dataPushSize = dataLen < 76 ? 1 + dataLen :
                         dataLen < 256 ? 2 + dataLen :
                         dataLen < 65536 ? 3 + dataLen : 5 + dataLen;
    const txSize = 10 + 148 * numInputs + 34 * 1 + dataPushSize; // base + inputs + change + OP_RETURN
    return Math.max(1, Math.ceil(txSize / 1000));
  }

  let selected = [];
  let totalIn = 0;
  for (const u of utxos) {
    selected.push(u);
    totalIn += u.value;
    if (totalIn >= calcFee(selected.length, dataBuffer.length)) break;
  }

  const fee = calcFee(selected.length, dataBuffer.length);
  const change = totalIn - fee;

  if (change < 0) {
    console.error(`Insufficient funds. Need ${fee} sats for fee, have ${totalIn} sats.`);
    process.exit(1);
  }

  const privKey = bsv.PrivKey.fromWif(w.wif);
  const keyPair = bsv.KeyPair.fromPrivKey(privKey);
  const pubKey = keyPair.pubKey;

  const txb = new bsv.TxBuilder();

  // OP_RETURN output (0 value)
  txb.outputToScript(new bsv.Bn(0), script);

  // Change output
  if (change >= 546) {
    txb.setChangeAddress(bsv.Address.fromString(w.address));
  }

  // Add inputs
  for (const u of selected) {
    const rawTx = await httpGet(`${WOC_BASE}/tx/${u.tx_hash}/hex`);
    const tx = bsv.Tx.fromHex(typeof rawTx === 'string' ? rawTx : rawTx.hex || rawTx);
    const txOut = tx.txOuts[u.tx_pos];
    const txHashBuf = Buffer.from(u.tx_hash, 'hex').reverse();
    txb.inputFromPubKeyHash(txHashBuf, u.tx_pos, txOut, pubKey);
  }

  txb.setFeePerKbNum(1); // 1 sat/kB = ~1 sat per tx under 1KB
  txb.build({ useAllInputs: true });
  for (let i = 0; i < selected.length; i++) {
    txb.signWithKeyPairs([keyPair]);
  }

  const txHex = txb.tx.toHex();

  // Broadcast
  const result = await httpPost(`${WOC_BASE}/tx/raw`, { txhex: txHex });
  const txid = typeof result === 'string' ? result.replace(/"/g, '') : result.txid || result;

  const postedText = dataBuffer.toString('utf8');
  console.log(`✅ Posted on chain!`);
  console.log(`TXID: ${txid}`);
  console.log(`Size: ${dataBuffer.length} bytes`);
  console.log(`Fee: ${fee} sats`);
  if (change >= 546) console.log(`Remaining: ${change} sats`);
  console.log(`View: https://whatsonchain.com/tx/${txid}`);
}

async function cmdRead(txid) {
  if (!txid) {
    console.error('Usage: node post.cjs read <txid>');
    process.exit(1);
  }

  const tx = await httpGet(`${WOC_BASE}/tx/${txid}`);
  
  // Find OP_RETURN output
  let found = false;
  for (const vout of tx.vout || []) {
    const asm = vout.scriptPubKey?.asm || '';
    if (asm.includes('OP_RETURN') || asm.startsWith('0 ')) {
      // Parse the hex data from asm
      const parts = asm.split(' ');
      // Find the data push (usually after OP_0 OP_RETURN)
      let dataHex = '';
      let started = false;
      for (const part of parts) {
        if (part === 'OP_RETURN' || part === '0') { started = true; continue; }
        if (started && part !== 'OP_RETURN') {
          // Could be a push size or the data itself
          if (/^[0-9a-f]+$/i.test(part) && part.length > 2) {
            dataHex = part;
          }
        }
      }
      if (dataHex) {
        try {
          const text = Buffer.from(dataHex, 'hex').toString('utf8');
          console.log(text);
          found = true;
        } catch {
          console.log(`(binary data: ${dataHex})`);
          found = true;
        }
      }
    }
  }
  if (!found) {
    console.log('No OP_RETURN data found in this transaction.');
  }
}

async function cmdScan(address, limit = 20) {
  if (!address) {
    const w = loadWallet();
    address = w.address;
  }
  
  const history = await httpGet(`${WOC_BASE}/address/${address}/history?limit=${limit}`);
  
  let posts = [];
  for (const item of history) {
    const tx = await httpGet(`${WOC_BASE}/tx/${item.tx_hash}`);
    for (const vout of tx.vout || []) {
      const asm = vout.scriptPubKey?.asm || '';
      if (asm.includes('OP_RETURN')) {
        const parts = asm.split(' ');
        let dataHex = '';
        let started = false;
        for (const part of parts) {
          if (part === 'OP_RETURN') { started = true; continue; }
          if (started && /^[0-9a-f]+$/i.test(part) && part.length > 2) {
            dataHex = part;
            break;
          }
        }
        if (dataHex) {
          try {
            const text = Buffer.from(dataHex, 'hex').toString('utf8');
            posts.push({ txid: item.tx_hash, text, height: item.height });
          } catch {
            posts.push({ txid: item.tx_hash, text: `(binary: ${dataHex.slice(0,40)}...)`, height: item.height });
          }
        }
      }
    }
  }

  if (!posts.length) {
    console.log(`No posts found for ${address}`);
    return;
  }

  console.log(`Posts by ${address} (${posts.length} found):\n`);
  for (const p of posts) {
    console.log(`[${p.height || 'mempool'}] ${p.txid}`);
    console.log(`  ${p.text}\n`);
  }
}

// --- Main ---

const [,, cmd, ...args] = process.argv;

if (!cmd || cmd === '--help' || cmd === '-h') {
  console.log(`BSV Post — Write permanent messages on the BSV blockchain

Commands:
  post "message"        Post text on chain (OP_RETURN)
  post --hex <hex>     Post raw hex data on chain
  read <txid>          Read OP_RETURN data from a transaction
  scan [address]       List posts by an address (defaults to your wallet)

Costs ~200-300 sats per post. Uses wallet from ~/.openclaw/bsv-wallet.json
View any post at https://whatsonchain.com/tx/<txid>`);
  process.exit(0);
}

const command = cmd === 'read' ? () => cmdRead(args[0]) :
                cmd === 'scan' ? () => cmdScan(args[0]) :
                cmd === 'post' || cmd === '--hex' ? () => cmdPost(cmd === '--hex' ? '--hex' : args[0]) :
                null;

if (!command) {
  // Default: treat everything as a post
  cmdPost(cmd).catch(e => { console.error(`Error: ${e.message}`); process.exit(1); });
} else {
  command().catch(e => { console.error(`Error: ${e.message}`); process.exit(1); });
}
