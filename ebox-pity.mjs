#!/usr/bin/env node
/*
 * ebox-pity.mjs — Pity Board & Analisis Waktu Gacha Terbaik untuk Ebox.
 *
 * Memantau blind box dengan harga <= Rp10.000:
 * - Menghitung probabilitas drop rate resmi UR per box
 * - Menghitung rata-rata roll (expected draws) untuk dapat UR (100 / rate%)
 * - Menghitung pity terkini (jumlah roll sejak UR terakhir) dari riwayat akun
 * - Menghitung progress % vs rata-rata:
 *     >= 100% : 🔥 JATUH TEMPO (Overdue — WAKTU TERBAIK UNTUK GACHA!)
 *     >= 70%  : ⚠️ MENDEKATI
 *     < 70%   : ✅ DINGIN (Masih jauh dari rata-rata)
 *
 * Pemakaian:
 *   node ebox-pity.mjs           — cetak tabel pity di terminal
 *   node ebox-pity.mjs --notify  — kirim tabel ke notifikasi ntfy HP
 *   node ebox-pity.mjs --max 15  — saring harga <= Rp15.000 (default: 10)
 *   node ebox-pity.mjs --json    — keluaran format JSON
 */

import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CFG = (() => {
  try { return JSON.parse(readFileSync(path.join(__dirname, 'config.json'), 'utf8')); } catch { return {}; }
})();

const API = (process.env.EBOX_API_BASE || CFG.apiBase || 'https://admin.ebox.zone/api').replace(/\/$/, '');
const NTFY_TOPIC = (process.env.EBOX_NTFY_TOPIC !== undefined ? process.env.EBOX_NTFY_TOPIC : CFG.ntfyTopic || '').trim();
const NTFY_URL = process.env.EBOX_NTFY_URL || 'https://ntfy.sh';

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
    urRate,
    ssrRate,
    avgDraw,
    topPrizes,
  };
}

async function fetchUserHistory(token) {
  let page = 1;
  const histByBox = {};
  while (page <= 20) {
    const r = await api('/player/draw-history', token, { page, per_page: 50 });
    const list = r.data?.data?.data || [];
    if (!list.length) break;
    for (const item of list) {
      const bName = item.main_product_name || 'Unknown';
      if (!histByBox[bName]) {
        histByBox[bName] = {
          total: 0,
          ur: 0,
          ssr: 0,
          sr: 0,
          r: 0,
          rollsSinceUR: 0,
          foundUR: false,
          latestWin: null,
        };
      }
      const h = histByBox[bName];
      h.total++;
      const g = item.grade_name || '';
      if (g === 'UR') {
        h.ur++;
        if (!h.foundUR) {
          h.foundUR = true;
          h.latestWin = item.sub_product_name;
        }
      } else if (g === 'SSR') h.ssr++;
      else if (g === 'SR') h.sr++;
      else if (g === 'R') h.r++;

      if (!h.foundUR) h.rollsSinceUR++;
    }
    if (page >= (r.data?.data?.total_pages || 1)) break;
    page++;
  }
  return histByBox;
}

async function main() {
  const token = loadToken();
  const rawBoxes = await fetchBoxesUnderPrice(token, MAX_PRICE);
  const histByBox = await fetchUserHistory(token);

  const boxes = await Promise.all(rawBoxes.map((b) => fetchBoxDetails(token, b)));

  const rows = boxes.map((b) => {
    const h = histByBox[b.name] || { total: 0, ur: 0, rollsSinceUR: 0, latestWin: null };
    const pity = h.rollsSinceUR;
    const avg = b.avgDraw;
    const pct = avg > 0 && pity > 0 ? Math.round((pity / avg) * 100) : 0;
    const sisa = avg > 0 ? avg - pity : 0;
    const icon = pct >= 100 ? '🔥' : pct >= 70 ? '⚠️' : '✅';
    const status = pct >= 100 ? 'JATUH TEMPO' : pct >= 70 ? 'Mendekati' : 'Dingin';

    return {
      id: b.id,
      name: b.name,
      price: b.price,
      pity,
      avg,
      pct,
      sisa,
      totalDraws: h.total,
      urWon: h.ur,
      urRate: b.urRate,
      topPrizes: b.topPrizes.slice(0, 2).join(', '),
      icon,
      status,
    };
  }).sort((a, b) => b.pct - a.pct);

  if (JSON_OUT) {
    console.log(JSON.stringify(rows, null, 2));
    return;
  }

  const lines = [];
  lines.push(`🎰 EBOX PITY BOARD (Harga ≤ Rp${MAX_PRICE.toLocaleString('id-ID')}.000)`);
  lines.push('─'.repeat(72));
  lines.push(
    'Barang Gacha'.padEnd(30) +
    'Harga'.padStart(8) +
    'Pity'.padStart(6) +
    'Rata2'.padStart(7) +
    '%Avg'.padStart(7) +
    'Sisa'.padStart(6) + '  Status'
  );
  lines.push('─'.repeat(72));

  for (const r of rows) {
    const shortName = r.name.length > 28 ? r.name.slice(0, 27) + '…' : r.name;
    const priceStr = `Rp${r.price}`;
    lines.push(
      shortName.padEnd(30) +
      priceStr.padStart(8) +
      String(r.pity).padStart(6) +
      String(r.avg).padStart(7) +
      (r.pct ? `${r.pct}%` : '-').padStart(7) +
      (r.pity ? String(r.sisa) : '-').padStart(6) +
      `  ${r.icon} ${r.status}`
    );
  }
  lines.push('─'.repeat(72));
  const due = rows.filter((r) => r.pct >= 100);
  if (due.length) {
    lines.push(`💡 WAKTU TERBAIK GACHA SEKARANG:`);
    for (const d of due) {
      lines.push(`   👉 ${d.name} (Pity: ${d.pity} roll / Rata2: ${d.avg} roll — Sudah ${d.pct}%!)`);
      if (d.topPrizes) lines.push(`      Hadiah UR: ${d.topPrizes}`);
    }
  } else {
    lines.push('💡 Belum ada item yang melewati rata-rata draw.');
  }

  const output = lines.join('\n');
  console.log(output);

  if (NOTIFY) {
    const notifMsg = rows.map((r) => {
      return `${r.icon} ${r.name} (Rp${r.price}k)\n   Pity: ${r.pity} / Rata2: ${r.avg} roll (${r.pct}%)${r.pct >= 100 ? ' — 🔥 WAKTU TERBAIK!' : ''}`;
    }).join('\n\n');
    await ntfy('🎰 Ebox: Pity Board (Rekomendasi Gacha)', notifMsg);
    console.log('\n✓ Notifikasi Pity Board berhasil dikirim ke ntfy HP.');
  }
}

main().catch((e) => {
  console.error('Error:', e?.message || e);
  process.exit(1);
});
