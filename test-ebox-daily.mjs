#!/usr/bin/env node
/*
 * test-ebox-daily.mjs — tes ebox-daily.mjs TANPA menyentuh akun sungguhan.
 *
 * Kenapa perlu: jalur yang benar-benar menulis (redeem-free-draw,
 * daily-point-claim) tidak boleh diuji dengan akun asli tiap kali kode diubah.
 * Jadi bot dijalankan sebagai proses anak melawan server HTTP tiruan yang
 * meniru bentuk respons Ebox, lalu kita periksa request yang masuk.
 *
 *   node test-ebox-daily.mjs
 */

import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BOT = path.join(__dirname, 'ebox-daily.mjs');
const UA_TOKEN = '1234|token-uji';

let failures = 0;
const ok = (cond, name) => {
  if (cond) console.log(`  ✅ ${name}`);
  else { console.log(`  ❌ ${name}`); failures++; }
};

/* ---------------- server tiruan ---------------- */

function mockApi() {
  const state = {
    freeDraw: { entitled: true, remaining_free_draw: 1, has_redeemed: false, free_draw_product_id: 110 },
    point: { is_available: true, next_claim_available_from: null, claim_hour: 12 },
    calls: [],
    mode: 'normal', // normal | auth | down
    boxesAvailable: true, // false = semua box terkunci (kondisi "tidak ada aksi")
    // Treasure Hunt: `open` meniru jam buka sesi (05:00 UTC). Sebelum buka,
    // server sungguhan menjawab 422 "has not opened yet".
    hunt: { open: false, joined: false, canJoin: false },
  };

  // Untuk mode --await: sesi dianggap buka begitu jam dinding melewati openMs,
  // jadi tes bisa memastikan bot benar-benar MENUNGGU, bukan menembak di awal.
  const openedNow = () => state.hunt.open === true || (Number(state.hunt.openMs) > 0 && Date.now() >= Number(state.hunt.openMs));

  const server = createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const url = req.url.replace('/api', '');
      state.calls.push(url);
      const send = (code, obj) => {
        res.writeHead(code, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(obj));
      };

      if (state.mode === 'down') return send(500, { status: false, message: 'internal error' });
      if (state.mode === 'auth') return send(401, { message: 'Invalid or expired token.' });
      if (req.headers.authorization !== `Bearer ${UA_TOKEN}`) return send(401, { message: 'Unauthenticated.' });

      if (url === '/player/free-draw-state') return send(200, { status: true, data: state.freeDraw });
      if (url === '/player/redeem-free-draw') {
        if (state.freeDraw.has_redeemed || !state.freeDraw.remaining_free_draw) {
          return send(400, { status: false, message: 'Free draw already redeemed.' });
        }
        state.freeDraw = { ...state.freeDraw, remaining_free_draw: 0, has_redeemed: true };
        const body = Buffer.concat(chunks).toString();
        if (!/main_product_id/.test(body) || !/110/.test(body)) {
          return send(422, { status: false, message: 'main_product_id wajib' });
        }
        return send(200, {
          status: true,
          data: { main_product_id: 110, sub_product_name: 'Prize - Rp35000', amount: '35.000000' },
          message: 'Free draw redeemed successfully.',
        });
      }
      if (url === '/player/daily-point-state') return send(200, { status: true, data: state.point });
      if (url === '/player/daily-point-claim') {
        if (!state.point.is_available) return send(400, { status: false, message: 'Not available.' });
        state.point = { ...state.point, is_available: false, next_claim_available_from: '2026-10-24 05:00:00' };
        return send(200, { status: true, data: {}, message: 'Daily points claimed successfully.' });
      }
      if (url === '/player/redeem-daily-box') {
        if (!state.boxesAvailable) return send(400, { status: false, message: 'Daily box is not available.' });
        const body = Buffer.concat(chunks).toString();
        if (!/name="main_product_id"\r\n\r\n7\r\n/.test(body)) {
          return send(422, { status: false, message: 'main_product_id tidak dikirim' });
        }
        state.boxesAvailable = false;   // server sungguhan menutup box setelah diklaim
        return send(200, {
          status: true,
          data: { main_product_id: 7, sub_product_name: 'Tom and Jerry Keychain' },
          message: 'Daily box redeemed successfully.',
        });
      }
      if (url === '/player/profile') {
        return send(200, { status: true, data: { level: { level_name: 'Level 5' }, user: { id: 1, currency_symbol: 'Rp' } } });
      }
      if (url === '/player/wallet-balance') {
        if (state.balanceDown) return send(500, { status: false, message: 'balance down' });
        return send(200, { status: true, data: { amount: '0.350000' } });
      }
      if (url === '/player/point-balance') {
        return send(200, { status: true, data: { amount: '79.730000' } });
      }
      if (url === '/player/free-hunt-session-listing') {
        // Dua sesi: Level 2 (milik akun Level 5) dan Level 30 (tidak memenuhi
        // syarat). Yang level-nya kurang TIDAK boleh dicoba sama sekali.
        return send(200, {
          status: true,
          data: [
            {
              session_id: 951, name: 'V2 Treasure Hunt', type: 1, type_label: 'Treasure Hunt',
              level_name: 'Level 2', sub_product_name: 'RC Drift Car', sub_product_amount: '88.000000',
              max_participants: 270, current_participants: state.hunt.full ? 270 : (state.hunt.joined ? 1 : 0),
              status: openedNow() ? 2 : 1, display_status: openedNow() ? 'open' : 'upcoming',
              open_at: state.hunt.openAt || '2026-10-24 05:00:00', draw_at: '2026-10-24 05:10:00', open_at_label: '05:00 AM',
              current_time_ms: Date.now(),
              is_joined: state.hunt.joined,
              can_join: state.hunt.openAt ? (openedNow() && !state.hunt.joined) : (state.hunt.canJoin && !state.hunt.joined),
            },
            {
              session_id: 957, name: 'V30 Treasure Hunt', type: 1, type_label: 'Treasure Hunt',
              level_name: 'Level 30', sub_product_name: 'Labubu Crystal', max_participants: 70, current_participants: 0,
              status: 2, display_status: 'open', open_at: '2026-10-24 12:00:00', open_at_label: '12:00 PM',
              is_joined: false, can_join: true,
            },
          ],
        });
      }
      if (url === '/player/free-hunt-join') {
        const body = Buffer.concat(chunks).toString();
        const sid = /name="session_id"\r\n\r\n(\d+)\r\n/.exec(body)?.[1];
        if (sid === '957') return send(422, { status: false, message: 'You are not eligible for this session.' });
        if (!openedNow()) return send(422, { status: false, message: 'This Treasure Hunt session has not opened yet.' });
        if (sid !== '951') return send(422, { status: false, message: 'session_id tidak dikirim' });
        state.hunt.joined = true;
        return send(200, { status: true, data: {}, message: 'Joined Treasure Hunt successfully.' });
      }
      if (url === '/player/draw-history') {
        return send(200, {
          status: true,
          data: {
            total: 1, total_pages: 1, current_page: 1, per_page: 5,
            data: state.boxesAvailable ? [] : [{
              main_product_name: 'Daily Blind Box - Lvl 2',
              sub_product_name: 'Ebox Cash Voucher',
              amount: '0.450000',
            }],
          },
        });
      }
      if (url === '/player/daily-box-listing') {
        return send(200, {
          status: true,
          data: [
            // Box Lv2 yang bisa dibuka/tutup sesuai state — meniru akun Level 2
            // sungguhan, di mana hanya satu box per level yang tersedia.
            {
              main_product_id: 7, name: 'Daily Blind Box - Lvl 2', min_level_id: 2,
              is_locked: !state.boxesAvailable, is_available: state.boxesAvailable,
            },
            { main_product_id: 8, name: 'Daily Blind Box - Lvl 11', min_level_id: 11, is_locked: true, is_available: false },
          ],
        });
      }
      return send(404, { message: 'not found' });
    });
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ server, state, base: `http://127.0.0.1:${port}/api` });
    });
  });
}

function runBot(base, dir, args = [], env = {}) {
  return new Promise((resolve) => {
    execFile(process.execPath, [BOT, ...args], {
      cwd: __dirname,
      env: {
        ...process.env,
        EBOX_API_BASE: base,
        EBOX_TOKEN: UA_TOKEN,
        DATA_DIR: dir,
        EBOX_NTFY_TOPIC: '',       // default: jangan pernah kirim notif sungguhan dari tes
        ...env,
      },
      timeout: 30000,
    }, (err, stdout, stderr) => resolve({ code: err?.code ?? 0, stdout, stderr }));
  });
}

/* Server ntfy tiruan: menangkap pesan tanpa menyentuh ntfy.sh sungguhan. */
function mockNtfy() {
  const messages = [];
  const server = createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      try { messages.push(JSON.parse(Buffer.concat(chunks).toString())); } catch { messages.push({ raw: true }); }
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('ok');
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, messages, url: `http://127.0.0.1:${server.address().port}/` });
    });
  });
}

/* ---------------- skenario ---------------- */

const { server, state, base } = await mockApi();
const dir = mkdtempSync(path.join(tmpdir(), 'ebox-test-'));

try {
  console.log('1. run pertama: free draw + poin diklaim');
  let r = await runBot(base, dir);
  ok(r.code === 0, 'exit 0');
  ok(/🎁 free-draw: Prize - Rp35000/.test(r.stdout), 'hadiah tercetak');
  ok(/✅ point/.test(r.stdout), 'poin diklaim');
  ok(state.calls.includes('/player/redeem-free-draw'), 'redeem-free-draw dipanggil');
  ok(state.calls.includes('/player/daily-point-claim'), 'daily-point-claim dipanggil');
  ok(state.calls.includes('/player/redeem-daily-box'), 'redeem-daily-box dipanggil');
  ok(/Ebox Cash Voucher \(0\.45\)/.test(r.stdout), 'hadiah box diambil dari draw-history');

  console.log('2. run kedua: tidak menembak klaim lagi (idempoten)');
  state.calls.length = 0;
  r = await runBot(base, dir);
  ok(r.code === 0, 'exit 0');
  ok(!state.calls.includes('/player/redeem-free-draw'), 'redeem tidak dipanggil ulang');
  ok(!state.calls.includes('/player/daily-point-claim'), 'claim tidak dipanggil ulang');
  ok(!state.calls.includes('/player/redeem-daily-box'), 'box tidak diklaim ulang');
  ok(/sudah draw hari ini/.test(r.stdout), 'laporan sudah draw');

  console.log('3. --check di state segar: tidak menulis apa pun');
  state.calls.length = 0;
  state.freeDraw = { entitled: true, remaining_free_draw: 1, has_redeemed: false, free_draw_product_id: 110 };
  state.point = { is_available: true, next_claim_available_from: null, claim_hour: 12 };
  state.boxesAvailable = true;
  r = await runBot(base, dir, ['--check']);
  ok(r.code === 0, 'exit 0');
  ok(!state.calls.includes('/player/redeem-free-draw'), 'redeem tidak dipanggil');
  ok(!state.calls.includes('/player/daily-point-claim'), 'claim tidak dipanggil');
  ok(!state.calls.includes('/player/redeem-daily-box'), 'box tidak diklaim saat --check');
  ok(/siap draw/.test(r.stdout), 'melaporkan siap draw');

  console.log('4. run penuh SESUDAH --check: benar-benar mengklaim');
  state.calls.length = 0;
  r = await runBot(base, dir);
  ok(state.calls.includes('/player/redeem-free-draw'), 'redeem dipanggil');
  ok(state.calls.includes('/player/redeem-daily-box'), 'box ikut diklaim');
  ok(/Prize - Rp35000/.test(r.stdout), 'hadiah tercetak');

  console.log('5. token ditolak: pesan jelas, tidak crash');
  state.mode = 'auth';
  state.calls.length = 0;
  r = await runBot(base, dir);
  ok(r.code === 0, 'tidak keluar dengan kode fatal');
  ok(/sesi mati — ambil token baru/.test(r.stdout), 'pesan sesi mati');
  ok(!state.calls.includes('/player/redeem-free-draw'), 'tidak ada percobaan redeem');

  console.log('6. server error 500: dilaporkan sebagai error, bukan token mati');
  state.mode = 'down';
  r = await runBot(base, dir);
  ok(/HTTP 500|internal error/.test(r.stdout), 'error 500 terlihat');
  ok(!/sesi mati/.test(r.stdout), 'tidak salah menyebut token mati');
  state.mode = 'normal';

  console.log('7. --json: keluaran bisa di-parse');
  state.freeDraw = { entitled: true, remaining_free_draw: 1, has_redeemed: false, free_draw_product_id: 110 };
  r = await runBot(base, dir, ['--check', '--json']);
  let parsed = null;
  try { parsed = JSON.parse(r.stdout); } catch { /* biar gagal di assert */ }
  // free-draw + point + boxes + hunt = 4 langkah
  ok(Array.isArray(parsed?.results) && parsed.results.length === 4, 'JSON berisi 4 hasil');
  ok(parsed?.results?.some((x) => x.step === 'hunt'), 'hasil hunt ikut dilaporkan');

  /* Notifikasi tidak pernah diuji sungguhan sebelumnya: jalur "ada aksi → kirim"
   * dan "gagal menetap → jangan spam" adalah bagian yang paling mudah rusak
   * tanpa kelihatan. Diuji lewat server ntfy tiruan. */
  const ntfyMock = await mockNtfy();
  const ntfEnv = { EBOX_NTFY_TOPIC: 'topik-uji', EBOX_NTFY_URL: ntfyMock.url };
  const ntfyDir = mkdtempSync(path.join(tmpdir(), 'ebox-ntfy-'));
  try {
    console.log('8. ada aksi: tepat satu notif berisi hadiah');
    state.freeDraw = { entitled: true, remaining_free_draw: 1, has_redeemed: false, free_draw_product_id: 110 };
    state.point = { is_available: false, next_claim_available_from: '2026-10-24 05:00:00', claim_hour: 12 };
    r = await runBot(base, ntfyDir, [], ntfEnv);
    ok(ntfyMock.messages.length === 1, `1 notif terkirim (dapat ${ntfyMock.messages.length})`);
    ok(ntfyMock.messages[0]?.topic === 'topik-uji', 'topic benar');
    ok(/Prize - Rp35000/.test(String(ntfyMock.messages[0]?.message || '')), 'hadiah ada di isi notif');

    console.log('9. tanpa aksi: tidak kirim notif');
    ntfyMock.messages.length = 0;
    state.boxesAvailable = false;      // semua box terkunci, free draw & poin sudah diambil
    r = await runBot(base, ntfyDir, [], ntfEnv);
    ok(ntfyMock.messages.length === 0, `0 notif (dapat ${ntfyMock.messages.length})`);
    ok(/tidak ada aksi/.test(r.stdout), 'log menyebut tidak ada aksi');
    state.boxesAvailable = true;

    console.log('10. gagal menetap (401) dua run: cuma satu notif');
    ntfyMock.messages.length = 0;
    state.mode = 'auth';
    r = await runBot(base, ntfyDir, [], ntfEnv);
    const afterFirst = ntfyMock.messages.length;
    r = await runBot(base, ntfyDir, [], ntfEnv);
    ok(afterFirst === 1, `run pertama kirim 1 notif (dapat ${afterFirst})`);
    ok(ntfyMock.messages.length === 1, `run kedua dibungkam jeda (total ${ntfyMock.messages.length})`);
    ok(/sesi mati/.test(String(ntfyMock.messages[0]?.message || '')), 'isi notif menyebut sesi mati');
    state.mode = 'normal';

    console.log('11. --check: ada aksi tapi TIDAK ada notif (alat diagnostik)');
    ntfyMock.messages.length = 0;
    state.boxesAvailable = true;                 // box siap → biasanya memicu notif
    r = await runBot(base, ntfyDir, ['--check'], ntfEnv);
    ok(ntfyMock.messages.length === 0, `0 notif saat --check (dapat ${ntfyMock.messages.length})`);
    ok(/mode cek — notif tidak dikirim/.test(r.stdout), 'log menjelaskan kenapa diam');

    console.log('12. notif gagal terkirim: kegagalan tercatat, bukan crash');
    state.mode = 'auth';                         // kondisi ini memang memicu notif
    ntfyMock.server.close();                     // ntfy mati
    await new Promise((r2) => setTimeout(r2, 50));
    r = await runBot(base, ntfyDir, [], { ...ntfEnv, EBOX_NOTIFY_COOLDOWN_MS: '1' });
    ok(r.code === 0, 'exit 0 walau ntfy mati');
    ok(/ntfy gagal/.test(r.stdout), 'kegagalan ntfy tercatat di log');
    state.mode = 'normal';
  } finally {
    rmSync(ntfyDir, { recursive: true, force: true });
    if (ntfyMock.server.listening) ntfyMock.server.close();
  }

  /* Treasure Hunt: jendela cuma 10 menit dan server menolak sebelum buka,
   * jadi tiga keadaan ini harus dibedakan dengan jelas. */
  const huntNtfy = await mockNtfy();
  const huntEnv = { EBOX_NTFY_TOPIC: 'topik-uji', EBOX_NTFY_URL: huntNtfy.url };
  const huntDir = mkdtempSync(path.join(tmpdir(), 'ebox-hunt-'));
  try {
    state.hunt = { open: false, joined: false, canJoin: false };
    console.log('13. --hunt-only sebelum sesi buka: tidak join, tidak notif');
    state.calls.length = 0;
    let h = await runBot(base, huntDir, ['--hunt-only'], huntEnv);
    ok(h.code === 0, 'exit 0');
    ok(!state.calls.includes('/player/free-hunt-join'), 'join tidak dipanggil');
    ok(!state.calls.includes('/player/free-draw-state'), 'klaim harian tidak ikut jalan');
    ok(/V2 Treasure Hunt: buka \d/.test(h.stdout), 'melaporkan jam buka dalam waktu lokal');
    ok(huntNtfy.messages.length === 0, `tidak ada notif (dapat ${huntNtfy.messages.length})`);

    console.log('14. --hunt-only saat sesi buka: join sesi Level 2, Level 30 dilewati');
    state.hunt = { open: true, joined: false, canJoin: true };
    state.calls.length = 0;
    h = await runBot(base, huntDir, ['--hunt-only'], huntEnv);
    ok(state.calls.filter((c) => c === '/player/free-hunt-join').length === 1, 'join dipanggil tepat sekali');
    ok(/🏹 hunt: V2 Treasure Hunt/.test(h.stdout), 'sesi V2 yang diikuti');
    ok(/RC Drift Car/.test(h.stdout), 'hadiah sesi ikut dilaporkan');
    ok(state.hunt.joined === true, 'server menerima join');
    ok(huntNtfy.messages.length === 1, `1 notif (dapat ${huntNtfy.messages.length})`);
    ok(/ikut Treasure Hunt/.test(String(huntNtfy.messages[0]?.title || '')), 'judul notif menyebut Treasure Hunt');
    // Isi notif harus "kaya" seperti boxkia: saldo, poin, level, dan daftar
    // hunt lain yang bisa diikuti — bukan cuma satu baris hasil.
    const isi = String(huntNtfy.messages[0]?.message || '');
    ok(/Rp0,35/.test(isi), 'saldo ada di notif');
    ok(/79,73 poin/.test(isi), 'poin ada di notif');
    ok(/Level 5/.test(isi), 'level ada di notif');
    ok(/Hunt yang bisa kamu ikuti hari ini/.test(isi), 'daftar hunt hari ini ada di notif');
    ok(/V30 Treasure Hunt/.test(isi) === false, 'sesi Level 30 tidak ikut didaftar (bukan milik kita)');

    console.log('15. run berikutnya: sudah ikut → tidak join ulang, tidak notif ulang');
    state.calls.length = 0;
    h = await runBot(base, huntDir, ['--hunt-only'], huntEnv);
    ok(!state.calls.includes('/player/free-hunt-join'), 'tidak join ulang');
    ok(/sudah ikut V2 Treasure Hunt/.test(h.stdout), 'laporan sudah ikut');
    ok(huntNtfy.messages.length === 1, `tidak ada notif tambahan (total ${huntNtfy.messages.length})`);

    console.log('16. kuota penuh: tidak menembak join yang pasti ditolak');
    state.hunt = { open: true, joined: false, canJoin: true, full: true };
    state.calls.length = 0;
    h = await runBot(base, huntDir, ['--hunt-only'], huntEnv);
    ok(!state.calls.includes('/player/free-hunt-join'), 'join tidak dipanggil saat kuota penuh');
    ok(/kuota penuh/.test(h.stdout), 'kuota penuh dilaporkan');
    ok(huntNtfy.messages.length === 1, `tidak ada notif tambahan (total ${huntNtfy.messages.length})`);

    /* Mode --await inilah yang dipakai GitHub Actions: job datang lebih awal
     * (cron bisa telat), lalu menunggu sampai detik buka. Dua hal yang WAJIB
     * terbukti: dia benar-benar menunggu, dan dia keluar cepat kalau sesinya
     * masih jauh (supaya dispatch tiap menit tidak menumpuk). */
    console.log('17. --await: tidur sampai jam buka lalu join');
    const openAtMs = Date.now() + 2500;
    const p2 = (n) => String(n).padStart(2, '0');
    const dd = new Date(openAtMs);
    const utcStr = `${dd.getUTCFullYear()}-${p2(dd.getUTCMonth() + 1)}-${p2(dd.getUTCDate())} ${p2(dd.getUTCHours())}:${p2(dd.getUTCMinutes())}:${p2(dd.getUTCSeconds())}`;
    state.hunt = { open: false, joined: false, openAt: utcStr, openMs: openAtMs };
    state.calls.length = 0;
    const t0 = Date.now();
    h = await runBot(base, huntDir, ['--await'], { ...huntEnv, EBOX_HUNT_ARM_MS: '10000', EBOX_HUNT_LEAD_MS: '200' });
    ok(state.hunt.joined === true, 'join terjadi setelah sesi buka');
    ok(Date.now() - t0 >= 1200, `benar-benar menunggu (${Date.now() - t0} ms)`);
    ok(!state.calls.includes('/player/redeem-free-draw'), 'tidak ikut klaim harian');
    ok(/🏹 hunt: V2 Treasure Hunt/.test(h.stdout), 'log melaporkan sesi yang diikuti');
    ok(huntNtfy.messages.length === 2, `notif join terkirim (total ${huntNtfy.messages.length})`);

    console.log('18b. saldo/poin gagal diambil: notif tetap terkirim, tanpa error palsu');
    state.hunt = { open: true, joined: false, canJoin: true };
    state.balanceDown = true;
    const before = huntNtfy.messages.length;
    h = await runBot(base, huntDir, ['--hunt-only'], huntEnv);
    const isi2 = String(huntNtfy.messages[before]?.message || '');
    ok(huntNtfy.messages.length === before + 1, 'notif join tetap terkirim');
    ok(!/Rp/.test(isi2), 'baris saldo dilewati (bukan angka palsu)');
    ok(/poin/.test(isi2), 'poin tetap tampil');
    ok(!/❌/.test(isi2), 'tidak ada baris error gara-gara saldo gagal');
    state.balanceDown = false;

    /* Regresi 24/10 09:16–09:58: EBOX_NTFY_TOPIC="" sengaja diset tes supaya
     * tidak mengirim ke HP, tapi `||` membuatnya bocor ke ntfyTopic di
     * config.json → tes menembak notif palsu ke HP. Sekarang env "" = mati. */
    console.log('19. EBOX_NTFY_TOPIC="" benar-benar menonaktifkan notif');
    state.hunt = { open: true, joined: false, canJoin: true };
    state.boxesAvailable = true;          // paksa ada aksi biar notif pasti dicoba
    state.calls.length = 0;
    const silentDir = mkdtempSync(path.join(tmpdir(), 'ebox-silent-'));
    const beforeSilent = huntNtfy.messages.length;
    try {
      h = await runBot(base, silentDir, [], { EBOX_NTFY_TOPIC: '', EBOX_NTFY_URL: huntNtfy.url });
      ok(h.code === 0, 'exit 0');
      ok(state.calls.includes('/player/redeem-daily-box') && state.calls.includes('/player/free-hunt-join'),
        'bot tetap menembak aksi (bukan dibungkam diam-diam)');
      ok(huntNtfy.messages.length === beforeSilent, `tidak ada notif terkirim (dapat ${huntNtfy.messages.length - beforeSilent})`);
    } finally {
      rmSync(silentDir, { recursive: true, force: true });
    }

    console.log('18. --await saat sesi masih jauh: keluar cepat tanpa join');
    state.hunt = { open: false, joined: false, openAt: '2026-10-24 19:00:00', openMs: Date.parse('2026-10-24T19:00:00Z') };
    state.calls.length = 0;
    const notifSebelum = huntNtfy.messages.length;
    const t1 = Date.now();
    h = await runBot(base, huntDir, ['--await'], huntEnv);
    ok(Date.now() - t1 < 8000, `tidak menunggu berjam-jam (${Date.now() - t1} ms)`);
    ok(/belum masuk jendela/.test(h.stdout), 'menjelaskan belum masuk jendela');
    ok(!state.calls.includes('/player/free-hunt-join'), 'tidak menembak join');
    ok(huntNtfy.messages.length === notifSebelum, 'tidak ada notif tambahan');
  } finally {
    rmSync(huntDir, { recursive: true, force: true });
    if (huntNtfy.server.listening) huntNtfy.server.close();
  }
} finally {
  server.close();
  rmSync(dir, { recursive: true, force: true });
}

console.log(failures ? `\n❌ ${failures} gagal` : '\n✅ semua lulus');
process.exit(failures ? 1 : 0);
