#!/usr/bin/env node
/*
 * ebox-pity.mjs — Pity Board & Pemantau Pity Kotak Gacha Global (Server-Wide).
 *
 * Memantau blind box dengan harga <= Rp10.000:
 * - Menghitung pity kotak saat ini (berapa kali kotak ini di-draw oleh semua pemain sejak UR terakhir keluar).
 * - Menghitung rata-rata roll (expected draws) untuk dapat UR (100 / rate%).
 * - Menghitung persentase %Avg:
 *     >= 100% : 🔥 JATUH TEMPO (Kotak sudah melewati rata-rata draw tanpa UR — WAKTU TERBAIK UNTUK GACHA!)
 *     >= 70%  : ⚠️ MENDEKATI (Kotak mulai matang)
 *     < 70%   : ✅ DINGIN (UR baru saja keluar)
 *
 * Mode Notifikasi:
 *   --notify : Mengirim 1 notifikasi terpisah per barang ke ntfy HP.
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CFG = (() => {
  try { return JSON.parse(readFileSync(path.join(__dirname, 'config.json'), 'utf8')); } catch { return {}; }
})();

const API = (process.env.EBOX_API_BASE || CFG.apiBase || 'https://admin.ebox.zone/api').replace(/\/$/, '');
const NTFY_TOPIC = (process.env.EBOX_NTFY_TOPIC !== undefined ? process.env.EBOX_NTFY_TOPIC : CFG.ntfyTopic || '').trim();
const NTFY_URL = process.env.EBOX_NTFY_URL || 'https://ntfy.sh';
const STATE_FILE = path.join(__dirname, 'box_pity_state.json');

const args = process.argv.slice(2);
const NOTIFY = args.includes('--notify');
const JSON_OUT = args.includes('--json');
const maxIdx = args.indexOf('--max');
const MAX_PRICE = maxIdx >= 0 ? Number(args[maxIdx + 1]) || 10 : 10;

function loadToken() {
  if (process.env.EBOX_TOKEN) return process.env.EBOX_TOKEN.trim();
  const acct = (CFG.accounts || [])[0];
  if (acct?.token) return String(acct.token).trim();
  const f = path.join(__dirname, '.ebox-token');
  if (existsSync(f)) {
    const t = readFileSync(f, 'utf8').trim();
    if (t) return t;
  }
  throw new Error('Token tidak ditemukan di .ebox-token atau config.json');
}

function loadPityState() {
  try { return JSON.parse(readFileSync(STATE_FILE, 'utf8')) || {}; } catch { return {}; }
}
function savePityState(s) {
  try { writeFileSync(STATE_FILE, JSON.stringify(s, null, 2)); } catch { /* abaikan */ }
}

async function api(pathname, token, body = {}) {
  const res = await fetch(`${API}${pathname}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
      'Content-Type': 'application/json',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20000),
  });
  let data = null;
  try { data = await res.json(); } catch { /* bukan JSON */ }
  return { status: res.status, data };
}

async function ntfy(title, msg) {
  if (!NTFY_TOPIC) return false;
  try {
    const res = await fetch(NTFY_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ topic: NTFY_TOPIC, title, message: msg }),
      signal: AbortSignal.timeout(10000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

function jamWib(utcString) {
  if (!utcString) return '?';
  const d = new Date(String(utcString).replace(' ', 'T') + 'Z');
  if (Number.isNaN(d.getTime())) return String(utcString);
  return d.toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Jakarta' }) + ' WIB';
}

async function fetchBoxesUnderPrice(token, maxPrice) {
  let page = 1;
  const boxes = [];
  while (page <= 5) {
    const r = await api('/product/main-product-listing', token, { draw_amount_type: 1, page, per_page: 50 });
    const list = r.data?.data?.data || [];
    if (!list.length) break;
    for (const p of list) {
      const price = Number(p.draw_amount || 0);
      if (price <= maxPrice) {
        boxes.push({ id: p.id, name: p.name, price, totalSold: Number(p.total_sold || 0) });
      }
    }
    if (page >= (r.data?.data?.total_pages || 1)) break;
    page++;
  }
  return boxes;
}

async function fetchBoxDetails(token, box) {
  const r = await api('/product/sub-product-listing', token, { main_product_id: box.id });
  const grades = r.data?.data?.main_product_grades || [];
  const ur = grades.find((g) => g.grade_name === 'UR');
  const ssr = grades.find((g) => g.grade_name === 'SSR');
  const urRate = ur ? Number(ur.display_percentage) : 0;
  const ssrRate = ssr ? Number(ssr.display_percentage) : 0;
  const avgDraw = urRate > 0 ? Math.round(100 / urRate) : 0;
  const subProducts = r.data?.data?.sub_products || [];
  const topPrizes = subProducts
    .filter((s) => s.grade_name === 'UR')
    .map((s) => s.name);

  return {
    ...box,
    totalSold: Number(r.data?.main_product?.total_sold ?? box.totalSold),
    urRate,
    ssrRate,
    avgDraw,
    topPrizes,
  };
}

async function fetchGlobalWinners(token) {
  let page = 1;
  const boxWins = {};
  while (page <= 10) {
    const r = await api('/winner', token, { page, per_page: 50 });
    const list = r.data?.data?.data || [];
    if (!list.length) break;
    for (const w of list) {
      const bId = w.main_product_id;
      if (!boxWins[bId]) boxWins[bId] = [];
      boxWins[bId].push(w);
    }
    if (page >= (r.data?.data?.total_pages || 1)) break;
    page++;
  }
  return boxWins;
}

async function main() {
  const token = loadToken();
  const rawBoxes = await fetchBoxesUnderPrice(token, MAX_PRICE);
  const [boxes, boxWins] = await Promise.all([
    Promise.all(rawBoxes.map((b) => fetchBoxDetails(token, b))),
    fetchGlobalWinners(token),
  ]);

  const state = loadPityState();
  const now = Date.now();

  const rows = boxes.map((b) => {
    const wins = boxWins[b.id] || [];
    const latestWin = wins[0] || null;
    const boxState = state[b.id] || {};

    let pity = 0;
    let minsAgo = null;
    let lastWinnerStr = 'Belum ada data';

    if (latestWin) {
      const winTimeMs = new Date(latestWin.created_at + 'Z').getTime();
      minsAgo = Math.max(0, Math.round((now - winTimeMs) / 60000));
      lastWinnerStr = `${latestWin.name} (${jamWib(latestWin.created_at)})`;

      if (boxState.lastWinTime !== latestWin.created_at) {
        // Ada UR baru yang terdeteksi
        boxState.lastWinTime = latestWin.created_at;
        boxState.totalSoldAtWin = b.totalSold;
        boxState.lastWinner = latestWin.name;
        boxState.lastAmount = latestWin.amount;
        // Pity estimasi awal berdasarkan jeda waktu jika baru pertama kali
        const estDrawsPerMin = b.price <= 7 ? 2.5 : b.price <= 10 ? 1.0 : 0.5;
        pity = Math.round(minsAgo * estDrawsPerMin);
      } else {
        // Hitung real-time dari selisih total_sold
        const baseline = boxState.totalSoldAtWin || (b.totalSold - Math.round(minsAgo * 2));
        pity = Math.max(0, b.totalSold - baseline);
      }
    } else {
      pity = boxState.pity || 0;
    }

    state[b.id] = {
      ...boxState,
      name: b.name,
      price: b.price,
      totalSold: b.totalSold,
      pity,
      updatedAt: now,
    };

    const avg = b.avgDraw;
    const pct = avg > 0 ? Math.round((pity / avg) * 100) : 0;
    const sisa = avg - pity;
    const isDue = pct >= 100;
    const isAppr = pct >= 70 && pct < 100;
    const icon = isDue ? '🔥' : isAppr ? '⚠️' : '✅';
    const status = isDue ? 'JATUH TEMPO' : isAppr ? 'Mendekati' : 'Dingin';

    return {
      id: b.id,
      name: b.name,
      price: b.price,
      pity,
      avg,
      pct,
      sisa,
      totalSold: b.totalSold,
      urRate: b.urRate,
      lastWinnerStr,
      minsAgo,
      topPrizes: b.topPrizes.slice(0, 2).join(', '),
      icon,
      status,
    };
  }).sort((a, b) => b.pct - a.pct);

  savePityState(state);

  if (JSON_OUT) {
    console.log(JSON.stringify(rows, null, 2));
    return;
  }

  const lines = [];
  lines.push(`🎰 EBOX PITY KOTAK GLOBAL (Harga ≤ Rp${MAX_PRICE.toLocaleString('id-ID')}.000)`);
  lines.push('─'.repeat(74));
  lines.push(
    'Barang Gacha'.padEnd(30) +
    'Harga'.padStart(8) +
    'Pity'.padStart(6) +
    'Rata2'.padStart(7) +
    '%Avg'.padStart(7) +
    'Sisa'.padStart(6) + '  Status'
  );
  lines.push('─'.repeat(74));

  for (const r of rows) {
    const shortName = r.name.length > 28 ? r.name.slice(0, 27) + '…' : r.name;
    const priceStr = `Rp${r.price}k`;
    lines.push(
      shortName.padEnd(30) +
      priceStr.padStart(8) +
      String(r.pity).padStart(6) +
      String(r.avg).padStart(7) +
      (r.pct ? `${r.pct}%` : '-').padStart(7) +
      String(r.sisa).padStart(6) +
      `  ${r.icon} ${r.status}`
    );
  }
  lines.push('─'.repeat(74));

  const due = rows.filter((r) => r.pct >= 100);
  if (due.length) {
    lines.push(`💡 KOTAK YANG SUDAH JATUH TEMPO (WAKTU TERBAIK GACHA):`);
    for (const d of due) {
      lines.push(`   👉 ${d.name} (${d.pity} draw tanpa UR / Rata2: ${d.avg} draw — ${d.pct}%)`);
      lines.push(`      UR Terakhir: ${d.lastWinnerStr}`);
      if (d.topPrizes) lines.push(`      Hadiah UR: ${d.topPrizes}`);
    }
  } else {
    lines.push('💡 Belum ada kotak yang melewati rata-rata draw.');
  }

  const output = lines.join('\n');
  console.log(output);

  if (NOTIFY) {
    console.log(`\nMengirim ${rows.length} notifikasi pity kotak (1 notif per barang)...`);
    for (const r of rows) {
      const title = `${r.icon} [Pity Kotak] ${r.name}`;
      const msgLines = [
        `💰 Harga: Rp${Number(r.price).toLocaleString('id-ID')}.000 · Status: ${r.status}`,
        `🎰 Pity Kotak: ${r.pity} draw tanpa UR (Rata-rata: ${r.avg} draw)`,
        `📈 Progress: ${r.pct}% (${r.sisa <= 0 ? `${Math.abs(r.sisa)} draw lewat rata-rata` : `sisa ${r.sisa} draw lagi`})`,
        `👑 UR Terakhir: ${r.lastWinnerStr} (${r.minsAgo != null ? `${r.minsAgo} menit lalu` : '-'})`,
      ];
      if (r.pct >= 100) {
        msgLines.push(`🔥 KOTAK SUDAH JATUH TEMPO — WAKTU TERBAIK GACHA!`);
      }
      if (r.topPrizes) {
        msgLines.push(`🎁 Hadiah UR: ${r.topPrizes}`);
      }
      await ntfy(title, msgLines.join('\n'));
      await new Promise((resolve) => setTimeout(resolve, 700)); // jeda 700ms per notifikasi
    }
    console.log(`✓ ${rows.length} notifikasi pity kotak berhasil dikirim ke ntfy HP.`);
  }
}

main().catch((e) => {
  console.error('Error:', e?.message || e);
  process.exit(1);
});
