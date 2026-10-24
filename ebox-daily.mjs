#!/usr/bin/env node
/*
 * ebox-daily.mjs — automasi klaim harian ebox.zone (padanan freebox-draw.mjs
 * di boxkia-bot).
 *
 * Yang dikerjakan tiap run:
 *   1. POST /player/free-draw-state    → kalau remaining_free_draw > 0 dan
 *      belum redeemed: POST /player/redeem-free-draw {main_product_id}
 *      (ini "free blind box" versi Ebox — hadiah voucher/poin, bukan saldo)
 *   2. POST /player/daily-point-state  → kalau is_available: POST
 *      /player/daily-point-claim
 *   3. POST /player/daily-box-listing  → box harian per level; yang
 *      `is_available` diklaim lewat POST /player/redeem-daily-box
 *      (gratis, `draw_amount: 0`). Box terkunci hanya dilaporkan.
 *   4. POST /player/free-hunt-session-listing → Treasure Hunt ("free hunt")
 *      yang syaratnya level terpenuhi (mis. Level 2+ → sesi V2). Join lewat
 *      POST /player/free-hunt-join {session_id}. Sesi ini BUKA 10 menit saja
 *      (05:00–05:10 UTC = 12:00–12:10 WIB) dan slotnya cepat penuh, jadi
 *      langkah ini dipanggil lebih rapat oleh jadwal terpisah (`--hunt-only`).
 *
 * Mode:
 *   node ebox-daily.mjs                — klaim yang siap, notif kalau ada aksi
 *   node ebox-daily.mjs --status-notify — baca status TANPA menulis, lalu kirim
 *                                        SATU notif ringkasan (data asli) —
 *                                        untuk memastikan saluran ntfy jalan
 *   node ebox-daily.mjs --hunt-only    — hanya cek/ikuti Treasure Hunt (dipakai
 *                                        jadwal menit-an di jendela 12:00 WIB)
 *   node ebox-daily.mjs --await        — tunggu sampai detik buka lalu ikut
 *                                        (dipakai GitHub Actions: dipanggil tiap
 *                                        menit, tidur presisi, tembak sekali)
 *   node ebox-daily.mjs --check        — lihat status saja, TIDAK menulis apa pun
 *   node ebox-daily.mjs --notify-all   — paksa kirim notif walau tidak ada aksi
 *   node ebox-daily.mjs --json         — keluarkan hasil sebagai JSON
 *
 * Token: env EBOX_TOKEN > config.json `accounts[].token` > file .ebox-token
 * (dibuat oleh ebox-token.mjs). Ingat: login baru mematikan token lama, jadi
 * jangan login di browser selama bot ini dipakai.
 */

import { readFileSync, appendFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CFG = (() => {
  try { return JSON.parse(readFileSync(path.join(__dirname, 'config.json'), 'utf8')); } catch { return {}; }
})();

// Override dipakai tes lawan server tiruan (sama seperti BOXKIA_FREEBOX_API_BASE).
const API = (process.env.EBOX_API_BASE || CFG.apiBase || 'https://admin.ebox.zone/api').replace(/\/$/, '');
/* `EBOX_NTFY_TOPIC` '' (string kosong) berarti NOTIF MATI — bukan "pakai dari
 * config". Operator `||` biasa membuat string kosong lolos ke ntfyTopic di
 * config.json, sehingga tes (yang sengaja mengosongkan env itu) malah
 * menembak notif sungguhan ke HP — kejadian 24/10 09:16–09:58: puluhan pesan
 * palsu berisi hadiah tiruan & "sesi mati". */
const NTFY_TOPIC = (process.env.EBOX_NTFY_TOPIC !== undefined
  ? process.env.EBOX_NTFY_TOPIC
  : CFG.ntfyTopic || '').trim();
const NTFY_URL = process.env.EBOX_NTFY_URL !== undefined
  ? process.env.EBOX_NTFY_URL
  : 'https://ntfy.sh/';
const DATA_DIR = process.env.DATA_DIR || __dirname;
const LOG_FILE = path.join(DATA_DIR, 'ebox-daily.log');
const STATE_FILE = path.join(DATA_DIR, 'ebox-notify-state.json');
const NOTIFY_COOLDOWN_MS = Number(process.env.EBOX_NOTIFY_COOLDOWN_MS || 6 * 3600e3);
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

const TRANSIENT = /fetch failed|aborted|timeout|socket|ECONN|EAI_AGAIN|terminated|network/i;

const args = new Set(process.argv.slice(2));
// --status-notify = mode baca saja (--check) yang juga MENGIRIM satu ringkasan.
const STATUS_NOTIFY = args.has('--status-notify');
const CHECK_ONLY = args.has('--check') || STATUS_NOTIFY;
const HUNT_ONLY = args.has('--hunt-only');
const HUNT_AWAIT = args.has('--await');
const NOTIFY_ALL = args.has('--notify-all');

// Mode --await (dipakai GitHub Actions): job datang lebih awal, tidur presisi
// sampai sesi buka, lalu menembak. Tanpa ini, jadwal cron yang telat beberapa
// menit akan melewatkan jendela 10 menit itu sepenuhnya.
//   ARM  : seberapa awal boleh mulai menunggu (detik sebelum buka)
//   LEAD : tembak sedikit sebelum jam buka supaya request mendarat tepat waktu
// Tembak 0,5 detik sebelum jam buka supaya request sudah di jalan saat server
// membuka sesi; kalau masih ditolak, ulang tiap 0,7 detik. Dengan lead 1,2s /
// retry 2,5s (nilai lama) tembakan pertama selalu mendarat terlalu awal lalu
// percobaan berikutnya baru 1,3 detik setelah sesi buka — terlalu lambat untuk
// kuota yang penuh dalam hitungan detik.
const HUNT_ARM_MS = Number(process.env.EBOX_HUNT_ARM_MS || 120000);
const HUNT_LEAD_MS = Number(process.env.EBOX_HUNT_LEAD_MS || 500);
const HUNT_RETRY_MS = Number(process.env.EBOX_HUNT_RETRY_MS || 700);
const HUNT_RETRY_MAX = Number(process.env.EBOX_HUNT_RETRY_MAX || 40);
const sleep = (ms) => new Promise((r) => setTimeout(r, Math.max(0, ms)));
const JSON_OUT = args.has('--json');

function log(...parts) {
  if (JSON_OUT) return;
  const line = `[${new Date().toLocaleString('id-ID')}] ${parts.join(' ')}`;
  console.log(line);
  try { appendFileSync(LOG_FILE, line + '\n'); } catch { /* abaikan */ }
}

function loadToken() {
  if (process.env.EBOX_TOKEN) return process.env.EBOX_TOKEN.trim();
  const acct = (CFG.accounts || [])[0];
  if (acct?.token) return String(acct.token).trim();
  const f = path.join(__dirname, '.ebox-token');
  if (existsSync(f)) {
    const t = readFileSync(f, 'utf8').trim();
    if (t) return t;
  }
  return null;
}

/* Satu tempat untuk semua panggilan API. `body` boleh FormData/objek/null. */
async function api(pathname, { token, body = null, json = false } = {}) {
  const headers = { Accept: 'application/json', 'User-Agent': UA, 'Accept-Language': 'id' };
  if (token) headers.Authorization = `Bearer ${token}`;
  let payload = body;
  if (json) {
    headers['Content-Type'] = 'application/json';
    payload = JSON.stringify(body ?? {});
  }
  const res = await fetch(`${API}${pathname}`, {
    method: 'POST',
    headers,
    body: payload,
    signal: AbortSignal.timeout(20000),
  });
  let data = null;
  try { data = await res.json(); } catch { /* bukan JSON */ }
  return { status: res.status, data };
}

/* Kode 401 di Ebox bukan cuma "token salah": setiap login baru membunuh token
 * sebelumnya (session takeover), jadi pesannya harus menyuruh ambil token baru
 * — bukan "coba lagi nanti". */
function describeFailure({ status, data }) {
  if (status === 401) return { kind: 'auth', msg: 'sesi mati — ambil token baru (node ebox-token.mjs login)' };
  const msg = data?.message || `HTTP ${status}`;
  if (/unauthenticated/i.test(msg)) return { kind: 'auth', msg: 'token kosong — login dulu' };
  return { kind: 'error', msg };
}

async function freeDraw(token) {
  const st = await api('/player/free-draw-state', { token });
  if (st.status !== 200 || !st.data?.status) return { step: 'free-draw', ...describeFailure(st) };

  const d = st.data.data || {};
  const left = Number(d.remaining_free_draw || 0);
  const productId = Number(d.free_draw_product_id || 0);
  if (d.has_redeemed || left < 1) {
    return { step: 'free-draw', kind: 'already', msg: 'sudah draw hari ini' };
  }
  if (!productId) return { step: 'free-draw', kind: 'error', msg: 'free_draw_product_id tidak ada di respons' };
  if (CHECK_ONLY) return { step: 'free-draw', kind: 'ready', msg: `siap draw (product ${productId})` };

  const form = new FormData();
  form.set('main_product_id', String(productId));
  const r = await api('/player/redeem-free-draw', { token, body: form });
  if (r.status !== 200 || !r.data?.status) return { step: 'free-draw', ...describeFailure(r) };
  const prize = r.data.data?.sub_product_name || 'hadiah';
  return { step: 'free-draw', kind: 'won', msg: prize, prize };
}

async function dailyPoint(token) {
  const st = await api('/player/daily-point-state', { token });
  if (st.status !== 200 || !st.data?.status) return { step: 'point', ...describeFailure(st) };

  const d = st.data.data || {};
  if (!d.is_available) {
    return { step: 'point', kind: 'already', msg: d.next_claim_available_from ? `berikutnya ${d.next_claim_available_from}` : 'belum waktunya' };
  }
  if (CHECK_ONLY) return { step: 'point', kind: 'ready', msg: 'poin harian siap diklaim' };

  const c = await api('/player/daily-point-claim', { token });
  if (c.status !== 200 || !c.data?.status) return { step: 'point', ...describeFailure(c) };
  return { step: 'point', kind: 'claimed', msg: c.data.message || 'poin diklaim' };
}

/* Box harian per level.
 * Klaim = POST /player/redeem-daily-box (multipart `main_product_id`), endpoint
 * yang ditemukan di bundle — BUKAN redeem-free-draw (itu untuk free draw harian
 * dengan `free_draw_product_id`). Box ini gratis (`draw_amount: "0.000000"`)
 * dan hanya terbuka sekali sehari per level, makanya aman diklaim otomatis. */
async function dailyBoxes(token) {
  const st = await api('/player/daily-box-listing', { token });
  if (st.status !== 200 || !st.data?.status) return { step: 'boxes', ...describeFailure(st) };
  const list = Array.isArray(st.data.data) ? st.data.data : [];
  const available = list.filter((b) => b.is_available && !b.is_locked);
  const locked = list.filter((b) => b.is_locked);

  const claimed = [];
  const failed = [];
  for (const b of available) {
    if (CHECK_ONLY) break;                     // --check tidak boleh menulis
    const form = new FormData();
    form.set('main_product_id', String(b.main_product_id));
    const r = await api('/player/redeem-daily-box', { token, body: form });
    if (r.status === 200 && r.data?.status) {
      claimed.push({ box: b.name, productId: b.main_product_id, prize: null, amount: null });
    } else {
      const why = r.data?.message || `HTTP ${r.status}`;
      failed.push(`${b.name}: ${why}`);
      log(`  ❌ ${b.name} → ${why}`);
    }
  }

  // Respons redeem-daily-box TIDAK memuat nama hadiah (terbukti di akun asli:
  // isinya hanya status). Nama item ada di /player/draw-history — jadi hadiah
  // diambil dari sana, dicocokkan lewat `main_product_name` + yang terbaru.
  if (claimed.length && !CHECK_ONLY) {
    const h = await api('/player/draw-history', { token, body: { page: 1, per_page: 5 }, json: true });
    const rows = Array.isArray(h.data?.data?.data) ? h.data.data.data : [];
    for (const c of claimed) {
      const hit = rows.find((x) => x.main_product_name === c.box);
      if (hit) {
        c.prize = hit.sub_product_name || null;
        c.amount = hit.amount ?? null;
      }
      const label = c.prize ? `${c.prize}${c.amount ? ` (${Number(c.amount)})` : ''}` : 'terklaim';
      log(`  🎁 ${c.box} → ${label}`);
    }
  }

  const nextUnlocked = list.find((b) => !b.is_locked && b.next_available_at);
  const msg = claimed.length
    ? `klaim ${claimed.length} box: ${claimed.map((c) => c.prize || c.box).join(', ')}`
    : available.length
      ? `${available.length} siap, ${locked.length} terkunci`
      : nextUnlocked
        ? `${nextUnlocked.level_name || nextUnlocked.name} buka ${jamWib(nextUnlocked.next_available_at)} (${locked.length} terkunci)`
        : `${locked.length} terkunci, 0 siap`;
  return {
    step: 'boxes',
    kind: claimed.length ? 'won' : failed.length ? 'error' : available.length ? 'ready' : 'already',
    msg, available, locked, claimed, failed, total: list.length,
  };
}

/* Treasure Hunt / "free hunt" harian.
 *
 * Jadwalnya pendek: sesi terbuka di `open_at` lalu diundi 10 menit kemudian
 * (05:00 → 05:10 UTC = 12:00 → 12:10 WIB), kuota 270 peserta dan kemarin
 * sudah penuh. Sebelum jam buka server MENOLAK dengan 422 "has not opened
 * yet", jadi percobaan lebih awal tidak berbahaya — hanya belum bisa.
 *
 * Yang diikuti hanya sesi bertipe level (type 1) yang level-nya sudah
 * terpenuhi. Rain Pool (type 2) butuh `min_spend` hari itu; kalau syaratnya
 * tidak terpenuhi, join-nya pasti ditolak, jadi tidak dicoba. */
function levelOf(name) {
  const m = /Level\s*(\d+)/i.exec(String(name || ''));
  return m ? Number(m[1]) : 0;
}

// Jam server di respons itu UTC. Dicetak sebagai WIB secara eksplisit (bukan
// zona waktu mesin) supaya laptop (UTC+7) dan runner GitHub (UTC) menulis hal
// yang sama — beda zona bikin log cloud seolah-olah sesinya buka jam 5 pagi.
function jamWib(utcString) {
  if (!utcString) return '?';
  const d = new Date(String(utcString).replace(' ', 'T') + 'Z');
  if (Number.isNaN(d.getTime())) return String(utcString);
  const jam = d.toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Jakarta' });
  return `${jam} WIB`;
}

/* Daftar sesi yang layak untuk akun ini, dipakai sebagai bahan notifikasi
 * ("bisa diikuti hari ini"). Diisi ulang setiap huntSessions() dipanggil. */
let HUNT_SESSIONS = [];

/* Ambil sesi hari ini + level akun, lalu saring yang memang milik kita. */
async function huntSessions(token) {
  // `date` yang diminta server adalah tanggal server (UTC), bukan tanggal lokal.
  const today = new Date().toISOString().slice(0, 10);
  const st = await api('/player/free-hunt-session-listing', { token, body: { date: today }, json: true });
  if (st.status !== 200 || !st.data?.status) return { ...describeFailure(st), step: 'hunt' };
  const sessions = Array.isArray(st.data.data) ? st.data.data : [];

  const prof = await api('/player/profile', { token });
  if (prof.status !== 200 || !prof.data?.status) return { ...describeFailure(prof), step: 'hunt' };
  const myLevel = levelOf(prof.data.data?.level?.level_name);

  const mine = sessions.filter((s) => Number(s.type) === 1 && levelOf(s.level_name) <= myLevel);
  HUNT_SESSIONS = mine.map((s) => ({
    name: s.name, level: s.level_name, open_at: s.open_at,
    prize: s.sub_product_name || null, joined: Boolean(s.is_joined),
  }));
  return { sessions, mine, myLevel };
}

function joinableSession(s) {
  const full = Number(s.current_participants) >= Number(s.max_participants) && Number(s.max_participants) > 0;
  if (s.is_joined || full) return false;
  return typeof s.can_join === 'boolean' ? s.can_join : String(s.display_status) === 'open';
}

async function joinHunt(token, s) {
  const form = new FormData();
  form.set('session_id', String(s.session_id));
  const r = await api('/player/free-hunt-join', { token, body: form });
  if (r.status === 200 && r.data?.status) return { ok: true };
  return { ok: false, why: r.data?.message || `HTTP ${r.status}` };
}

/* Satu putaran: ikut yang sudah bisa, laporkan sisanya. */
async function freeHunt(token) {
  const got = await huntSessions(token);
  if (got.step) return { step: 'hunt', ...got };
  const { mine, myLevel } = got;

  if (!mine.length) {
    return { step: 'hunt', kind: 'already', msg: `tidak ada sesi Treasure Hunt untuk Level ${myLevel}` };
  }

  const justJoined = [];   // baru saja ikut di run ini (memicu notif)
  const done = [];         // sudah ikut dari run sebelumnya (jangan notif lagi)
  const waiting = [];
  for (const s of mine) {
    if (s.is_joined) { done.push(s.name); continue; }
    const full = Number(s.current_participants) >= Number(s.max_participants) && Number(s.max_participants) > 0;
    if (full) { waiting.push(`${s.name}: kuota penuh`); continue; }
    if (!joinableSession(s)) { waiting.push(`${s.name}: buka ${jamWib(s.open_at)}`); continue; }
    if (CHECK_ONLY) return { step: 'hunt', kind: 'ready', msg: `siap ikut ${s.name} (mode cek)` };

    const r = await joinHunt(token, s);
    if (r.ok) justJoined.push(`${s.name}${s.sub_product_name ? ` → ${s.sub_product_name}` : ''}`);
    else waiting.push(`${s.name}: ${r.why}`);
  }

  if (justJoined.length) return { step: 'hunt', kind: 'joined', msg: justJoined.join(', ') };
  if (waiting.length) return { step: 'hunt', kind: 'waiting', msg: waiting.join(' · ') };
  if (done.length) return { step: 'hunt', kind: 'already', msg: `sudah ikut ${done.join(', ')}` };
  return { step: 'hunt', kind: 'already', msg: 'tidak ada sesi baru' };
}

/* Mode GitHub Actions: tunggu sampai detik buka, baru tembak.
 *
 * Cron GitHub/cron-job.org bisa telat puluhan detik (kadang beberapa menit),
 * sedangkan jendela join cuma 10 menit. Jadi job dipanggil tiap menit: kalau
 * sesi berikutnya masih jauh, job langsung keluar (murah); kalau buka tinggal
 * <HUNT_ARM_MS>, job tidur memakai jam server (bukan jam runner yang bisa
 * meleng) lalu menembak join. Kalau server masih bilang "belum buka", coba
 * lagi tiap HUNT_RETRY_MS sampai jendela habis. */
async function freeHuntAwait(token) {
  const got = await huntSessions(token);
  if (got.step) return { step: 'hunt', ...got };
  const { mine, myLevel } = got;

  if (!mine.length) return { step: 'hunt', kind: 'already', msg: `tidak ada sesi Treasure Hunt untuk Level ${myLevel}` };

  const done = mine.filter((s) => s.is_joined);
  const targets = mine
    .filter((s) => !s.is_joined && !(Number(s.current_participants) >= Number(s.max_participants) && Number(s.max_participants) > 0))
    .sort((a, b) => Date.parse(String(a.open_at).replace(' ', 'T') + 'Z') - Date.parse(String(b.open_at).replace(' ', 'T') + 'Z'));

  if (!targets.length) {
    return { step: 'hunt', kind: 'already', msg: done.length ? `sudah ikut ${done.map((s) => s.name).join(', ')}` : 'tidak ada sesi baru' };
  }

  // Jam server dipakai sebagai acuan, supaya clock runner yang meleset tidak
  // membuat tembakan maju/mundur.
  const serverNow = Number(mine[0].current_time_ms || 0);
  const skew = serverNow > 0 ? serverNow - Date.now() : 0;

  const target = targets[0];
  const openMs = Date.parse(String(target.open_at).replace(' ', 'T') + 'Z');
  const waitMs = openMs - skew - Date.now();

  if (waitMs > HUNT_ARM_MS) {
    return { step: 'hunt', kind: 'waiting', msg: `buka ${jamWib(target.open_at)} — belum masuk jendela` };
  }

  if (waitMs > 0) {
    log(`  ⏰ menunggu ${Math.round(waitMs / 1000)}s sampai ${jamWib(target.open_at)}`);
    await sleep(waitMs - HUNT_LEAD_MS);
  }

  let lastWhy = 'sesi belum terbuka';
  for (let i = 0; i < HUNT_RETRY_MAX; i++) {
    const r = await joinHunt(token, target);
    if (r.ok) {
      return { step: 'hunt', kind: 'joined', msg: `${target.name}${target.sub_product_name ? ` → ${target.sub_product_name}` : ''}` };
    }
    lastWhy = r.why;
    // Ditolak karena alasan lain (bukan "belum buka") — tidak ada gunanya
    // mengulang 40 kali; laporkan saja.
    if (!/open|available|started|belum|not yet/i.test(String(r.why))) {
      return { step: 'hunt', kind: 'waiting', msg: `${target.name}: ${r.why}` };
    }
    await sleep(HUNT_RETRY_MS);
  }

  return { step: 'hunt', kind: 'error', msg: `gagal ikut ${target.name}: ${lastWhy}` };
}

/* Ringkasan akun untuk isi notifikasi: saldo, poin, level. Semua best-effort
 * — kalau salah satu endpoint bermasalah, notifikasi tetap terkirim tanpa
 * baris itu. Endpoint saldo/poin yang error TIDAK boleh membuat bot melapor
 * "ada masalah" (itu yang bikin notif palsu). */
async function snapshot(token) {
  const out = {};
  try {
    const p = await api('/player/profile', { token });
    if (p.status === 200 && p.data?.status) {
      out.level = p.data.data?.level?.level_name || null;
      out.symbol = p.data.data?.user?.currency_symbol || 'Rp';
    }
  } catch { /* abaikan */ }
  try {
    const b = await api('/player/wallet-balance', { token });
    const amt = b.data?.data?.amount;
    if (amt != null && amt !== '') out.saldo = Number(amt);
  } catch { /* abaikan */ }
  try {
    const pb = await api('/player/point-balance', { token });
    const amt = pb.data?.data?.amount;
    if (amt != null && amt !== '') out.poin = Number(amt);
  } catch { /* abaikan */ }
  try {
    const h = await api('/player/draw-history', { token, body: { page: 1, per_page: 100 }, json: true });
    const rows = Array.isArray(h.data?.data?.data)
      ? h.data.data.data
      : Array.isArray(h.data?.data)
      ? h.data.data
      : [];
    if (rows.length) {
      let ur = 0;
      let ssr = 0;
      let foundUR = false;
      let foundSSR = false;
      for (const item of rows) {
        const grade = item.grade_name || '';
        if (!foundUR) {
          if (grade === 'UR') foundUR = true;
          else ur++;
        }
        if (!foundSSR) {
          if (grade === 'SSR' || grade === 'UR') foundSSR = true;
          else ssr++;
        }
        if (foundUR && foundSSR) break;
      }
      out.pity = { ur, ssr, total: h.data?.data?.total ?? h.data?.total ?? null };
    }
  } catch { /* abaikan */ }
  return out;
}

const angka = (n) => Number(n).toLocaleString('id-ID', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

async function ntfy(title, msg) {
  if (!NTFY_TOPIC) return false;
  try {
    const res = await fetch(NTFY_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ topic: NTFY_TOPIC, title, message: msg }),
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) { log(`⚠ ntfy gagal: HTTP ${res.status}`); return false; }
    return true;
  } catch (e) {
    log(`⚠ ntfy gagal: ${e?.message || e}`);
    return false;
  }
}

function loadState() {
  try { return JSON.parse(readFileSync(STATE_FILE, 'utf8')) || {}; } catch { return {}; }
}
function saveState(s) {
  try {
    const cur = loadState();
    writeFileSync(STATE_FILE, JSON.stringify({ ...cur, ...s }));
  } catch { /* abaikan */ }
}

async function main() {
  const token = loadToken();
  if (!token) {
    log('⚠ token tidak ada — jalankan: node ebox-token.mjs login <email> <password>');
    if (!JSON_OUT) await ntfy('❌ Ebox: token kosong', 'Jalankan node ebox-token.mjs login <email> <password>');
    process.exitCode = 1;
    return;
  }

  log(`🎁 Ebox harian${CHECK_ONLY ? ' (cek saja)' : ''}${HUNT_ONLY ? ' (hunt saja)' : ''}${HUNT_AWAIT ? ' (tunggu buka)' : ''}`);

  // Berurutan, bukan paralel: redeem & claim di akun yang sama bisa saling
  // mengganggu state, dan urutannya cuma beberapa request.
  const results = [];
  const steps = HUNT_AWAIT
    ? [freeHuntAwait]
    : HUNT_ONLY
      ? [freeHunt]
      : [freeDraw, dailyPoint, dailyBoxes, freeHunt];
  for (const fn of steps) {
    try {
      const r = await fn(token);
      results.push(r);
      const icon = r.kind === 'won' ? '🎁' : r.kind === 'claimed' ? '✅' : r.kind === 'joined' ? '🏹' : r.kind === 'ready' ? '🎯' : r.kind === 'auth' ? '🔑' : r.kind === 'error' ? '❌' : '⏳';
      log(`  ${icon} ${r.step}: ${r.msg}`);
    } catch (e) {
      // Error jaringan sesaat: jangan hentikan langkah lain, dan jangan
      // dilaporkan sebagai token mati (itu pernah menyesatkan di Boxkia).
      const msg = e?.message || String(e);
      results.push({ step: fn.name, kind: TRANSIENT.test(msg) ? 'net' : 'error', msg });
      log(`  🌐 ${fn.name}: ${msg}`);
    }
  }

  const events = results.filter((r) => ['won', 'claimed', 'joined', 'ready'].includes(r.kind));
  // Di mode --await (dipanggil tiap menit) sesi mati TIDAK dilaporkan: itu tugas
  // run harian, supaya HP tidak dibanjiri pesan yang sama tiap menit.
  const hardErrors = results.filter((r) =>
    (r.kind === 'error' || r.kind === 'auth') && !(HUNT_AWAIT && r.kind === 'auth'));
  const netErrors = results.filter((r) => r.kind === 'net');

  if (JSON_OUT) {
    console.log(JSON.stringify({ at: new Date().toISOString(), checkOnly: CHECK_ONLY, results }, null, 2));
  }

  // Notif: hanya kalau ada aksi nyata, atau ada error non-jaringan. Kondisi
  // gagal yang MENETAP (mis. token mati berhari-hari) dibungkam lewat sidik
  // jari + jeda, supaya tidak jadi spam tiap jam.
  const st = loadState();
  const PERIODIC_STATUS_MS = Number(process.env.EBOX_STATUS_INTERVAL_MS || (3 * 3600 * 1000));
  const isTimeForPeriodicStatus = !CHECK_ONLY && !HUNT_ONLY && Boolean(st.lastStatusAt) &&
    (Date.now() - Number(st.lastStatusAt) >= PERIODIC_STATUS_MS);

  if (!st.lastStatusAt) {
    saveState({ lastStatusAt: Date.now() });
  }

  const worth = STATUS_NOTIFY || isTimeForPeriodicStatus || (!CHECK_ONLY && (NOTIFY_ALL || events.length > 0 || hardErrors.length > 0));
  if (!worth) {
    if (CHECK_ONLY) log('  (mode cek — notif tidak dikirim)');
    else if (netErrors.length) log('  (gangguan jaringan — notif dilewati)');
    else log('  (tidak ada aksi — notif dilewati)');
    return;
  }

  const head = isTimeForPeriodicStatus
    ? '📊 Ebox: status 3 jam & persiapan'
    : STATUS_NOTIFY
      ? '📊 Ebox: status terkini'
      : results.some((r) => r.kind === 'won')
        ? '🎁 Ebox: dapat hadiah!'
        : results.some((r) => r.kind === 'joined')
          ? '🏹 Ebox: ikut Treasure Hunt'
          : events.length
            ? '✅ Ebox: klaim harian jalan'
            : '⚠️ Ebox: ada masalah';

  // Ringkasan akun ditaruh paling atas (seperti notif boxkia: saldo + progres),
  // diambil hanya saat notifikasi memang akan dikirim.
  const snap = await snapshot(token);
  const ringkas = [];
  if (snap.saldo != null) ringkas.push(`💰 ${snap.symbol || 'Rp'}${angka(snap.saldo)}`);
  if (snap.poin != null) ringkas.push(`🎯 ${angka(snap.poin)} poin`);
  if (snap.level) ringkas.push(`⭐ ${snap.level}`);
  if (snap.pity) {
    const pBits = [];
    if (snap.pity.ur != null) pBits.push(`${snap.pity.ur} no UR`);
    if (snap.pity.ssr != null) pBits.push(`${snap.pity.ssr} no SSR`);
    if (pBits.length) ringkas.push(`🎰 Pity: ${pBits.join(' · ')}`);
  }

  const detail = (ringkas.length ? [ringkas.join(' · '), ''] : []).concat(results.map((r) => {
    const icon = r.kind === 'won' ? '🎁' : r.kind === 'claimed' ? '✅' : r.kind === 'joined' ? '🏹' : r.kind === 'ready' ? '🎯' : r.kind === 'auth' ? '🔑' : r.kind === 'net' ? '🌐' : r.kind === 'error' ? '❌' : '⏳';
    const extra = r.step === 'boxes'
      ? [
          ...(r.claimed || []).map((c) => `\n   🎁 ${c.box}${c.prize ? `: ${c.prize}` : ''}`),
          ...(r.failed || []).map((c) => `\n   ❌ ${c}`),
        ].join('')
      : '';
    return `${icon} ${r.step}: ${r.msg}${extra}`;
  }), HUNT_SESSIONS.length
    ? ['', '— Hunt yang bisa kamu ikuti hari ini:']
        .concat(HUNT_SESSIONS.map((s) => `   ${s.joined ? '✅' : '•'} ${jamWib(s.open_at)} ${s.name} (${s.level})${s.prize ? ` — ${s.prize}` : ''}`))
    : []).join('\n');

  if (isTimeForPeriodicStatus) {
    await ntfy(head, detail);
    saveState({ lastStatusAt: Date.now() });
    try {
      const pityScript = path.join(__dirname, 'ebox-pity.mjs');
      if (existsSync(pityScript)) {
        import('node:child_process').then(({ fork }) => {
          fork(pityScript, ['--notify'], { stdio: 'ignore', detached: true }).unref();
        });
      }
    } catch { /* abaikan */ }
    return;
  }
  if (STATUS_NOTIFY) { await ntfy(head, detail); return; }   // selalu kirim, tanpa jeda
  if (events.length) saveState({});        // kondisi berubah → buka kunci notif
  else if (!NOTIFY_ALL) {
    const sig = results.map((r) => `${r.step}:${r.kind}:${r.msg}`).join('|');
    const st = loadState();
    if (st.sig === sig && Date.now() - Number(st.at || 0) < NOTIFY_COOLDOWN_MS) {
      log(`  (notif identik terakhir ${Math.round((Date.now() - Number(st.at || 0)) / 60000)} menit lalu — dilewati)`);
      return;
    }
    const sent = await ntfy(head, detail);
    if (sent) saveState({ sig, at: Date.now() });   // simpan hanya kalau benar-benar terkirim
    return;
  }

  await ntfy(head, detail);
}

main().catch((e) => {
  log('FATAL:', e?.message || e);
  process.exitCode = 1;
});
