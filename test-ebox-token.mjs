#!/usr/bin/env node
/*
 * test-ebox-token.mjs — tes ebox-token.mjs lawan server tiruan.
 *
 * Yang paling mudah salah di sini adalah ROUTING: akun Ebox memakai nomor
 * telepon, tapi perintahnya bernama "login" dan orang biasa mengetik email.
 * Salah jalur bukan cuma gagal — ia bisa MEMBUAT AKUN BARU yang berbeda dari
 * akun asli. Jadi tiap cabang diperiksa dari body multipart yang benar-benar
 * dikirim, tanpa mengirim SMS atau menyentuh server Ebox.
 *
 *   node test-ebox-token.mjs
 */

import { createServer } from 'node:http';
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BIN = path.join(__dirname, 'ebox-token.mjs');

let failures = 0;
const ok = (cond, name) => {
  if (cond) console.log(`  ✅ ${name}`);
  else { console.log(`  ❌ ${name}`); failures++; }
};

function mockApi() {
  const state = { calls: [], otp: '123456', mode: 'normal' };

  const server = createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString();
      const url = req.url.replace('/api', '');
      state.calls.push({ url, body });
      const send = (code, obj) => {
        res.writeHead(code, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(obj));
      };

      if (url === '/send-otp') return send(200, { status: true, data: { is_new_user: false }, message: 'OTP sent successfully.' });

      if (url === '/player/profile') {
        if (!/^Bearer 9999\|/.test(String(req.headers.authorization || ''))) return send(401, { message: 'Invalid or expired token.' });
        return send(200, { status: true, data: { user: { id: 7, name: 'Uji', email: null, phone_code: '+62', phone_no: '81234567890', currency_symbol: 'Rp' }, level: { level_name: 'Level 1' } } });
      }
      if (url === '/player/wallet-balance') return send(200, { status: true, data: { amount: '0.000000' } });

      if (url === '/player/login') {
        if (state.mode === 'bad-otp') return send(422, { status: false, message: 'Invalid OTP. Please try again.' });
        if (state.mode === 'new-user') {
          return send(200, { status: true, data: { token: '9999|tok', token_type: 'Bearer', is_new_user: true } });
        }
        return send(200, { status: true, data: { token: '9999|tok', token_type: 'Bearer', is_new_user: false } });
      }
      return send(404, { message: 'not found' });
    });
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, state, base: `http://127.0.0.1:${server.address().port}/api` });
    });
  });
}

function run(base, args, { dir, input = '' } = {}) {
  return new Promise((resolve) => {
    const child = execFile(process.execPath, [BIN, ...args], {
      cwd: __dirname,
      env: {
        ...process.env,
        EBOX_API_BASE: base,
        EBOX_TOKEN_FILE: path.join(dir, '.ebox-token'),
        DATA_DIR: dir,
      },
      timeout: 20000,
    }, (err, stdout, stderr) => resolve({ code: err?.code ?? 0, stdout, stderr }));
    child.stdin.end(input);   // jawab prompt OTP / pastikan tidak menggantung
  });
}

const lastCall = (state, url) => [...state.calls].reverse().find((c) => c.url === url);

const { server, state, base } = await mockApi();
const dir = mkdtempSync(path.join(tmpdir(), 'ebox-token-'));

try {
  console.log('1. otp: kirim kode lalu login type=1 auth_method=1');
  state.calls.length = 0;
  let r = await run(base, ['otp', '0812-3456-7890'], { dir, input: '123456\n' });
  ok(r.code === 0, 'exit 0');
  const sendOtp = lastCall(state, '/send-otp');
  ok(!!sendOtp, '/send-otp dipanggil');
  ok(/name="type"\r\n\r\n1\r\n/.test(sendOtp.body), 'type=1 (telepon)');
  ok(/name="phone_no"\r\n\r\n81234567890\r\n/.test(sendOtp.body), 'nomor dinormalisasi 81234567890');
  const login = lastCall(state, '/player/login');
  ok(/name="auth_method"\r\n\r\n1\r\n/.test(login.body), 'auth_method=1 (OTP)');
  ok(/name="otp"\r\n\r\n123456\r\n/.test(login.body), 'OTP dari prompt terkirim');
  ok(readFileSync(path.join(dir, '.ebox-token'), 'utf8').trim() === '9999|tok', 'token tersimpan');

  console.log('2. otp --code: TIDAK memanggil /send-otp');
  state.calls.length = 0;
  r = await run(base, ['otp', '81234567890', '--code', '123456'], { dir });
  ok(r.code === 0, 'exit 0');
  ok(!lastCall(state, '/send-otp'), '/send-otp tidak dipanggil');

  console.log('3. phone: auth_method=2 dengan password');
  state.calls.length = 0;
  r = await run(base, ['phone', '+62 812 3456 7890', 'rahasia123'], { dir });
  ok(r.code === 0, 'exit 0');
  const l3 = lastCall(state, '/player/login');
  ok(/name="auth_method"\r\n\r\n2\r\n/.test(l3.body), 'auth_method=2 (password)');
  ok(/name="phone_code"\r\n\r\n\+62\r\n/.test(l3.body), 'phone_code=+62');
  ok(/name="password"\r\n\r\nrahasia123\r\n/.test(l3.body), 'password terkirim');

  console.log('4. login <email>: tetap jalur email (type=2)');
  state.calls.length = 0;
  r = await run(base, ['login', 'kamu@contoh.com', 'rahasia123'], { dir });
  ok(r.code === 0, 'exit 0');
  const l4 = lastCall(state, '/player/login');
  ok(/name="type"\r\n\r\n2\r\n/.test(l4.body), 'type=2 (email)');
  ok(/name="email"\r\n\r\nkamu@contoh\.com\r\n/.test(l4.body), 'email terkirim');

  console.log('5. login <nomor>: dialihkan ke jalur telepon');
  state.calls.length = 0;
  r = await run(base, ['login', '081234567890', 'rahasia123'], { dir });
  ok(r.code === 0, 'exit 0');
  const l5 = lastCall(state, '/player/login');
  ok(/name="type"\r\n\r\n1\r\n/.test(l5.body), 'jadi type=1, bukan email');
  ok(/memakai jalur telepon/.test(r.stderr), 'memberi tahu pengalihan jalur');

  console.log('6. akun baru: peringatan tegas (bukan diam-diam)');
  state.mode = 'new-user';
  r = await run(base, ['phone', '81299999999', 'x'], { dir });
  ok(/AKUN BARU/.test(r.stderr), 'peringatan akun baru muncul');
  state.mode = 'normal';

  console.log('7. OTP salah: gagal jelas, exit 1');
  state.mode = 'bad-otp';
  r = await run(base, ['otp', '81234567890', '--code', '000000'], { dir });
  ok(r.code === 1, 'exit 1');
  ok(/Invalid OTP/.test(r.stderr), 'pesan server diteruskan');
  state.mode = 'normal';

  console.log('8. nomor ngawur & argumen kurang: ditolak lokal (tanpa request)');
  state.calls.length = 0;
  r = await run(base, ['phone', '123', 'x'], { dir });
  ok(r.code === 1, 'nomor pendek ditolak');
  ok(state.calls.length === 0, 'tidak ada request terkirim');
  r = await run(base, ['phone', '81234567890'], { dir });
  ok(r.code === 1, 'password kurang ditolak');
  ok(/pakai:/.test(r.stderr), 'menampilkan cara pakai');

  console.log('9. check: verifikasi token tersimpan');
  r = await run(base, ['check'], { dir });
  ok(r.code === 0, 'exit 0');
  ok(/telepon\s+\+6281234567890/.test(r.stdout), 'nomor tampil di profil');

  console.log('10. receive: token dari HP ditolak/diterima dengan benar');
  const port = 18000 + Math.floor(Math.random() * 2000);
  const dir2 = mkdtempSync(path.join(tmpdir(), 'ebox-recv-'));
  const child = spawn(process.execPath, [BIN, 'receive', String(port)], {
    cwd: __dirname,
    env: { ...process.env, EBOX_API_BASE: base, EBOX_TOKEN_FILE: path.join(dir2, '.ebox-token') },
  });
  try {
    const url = await new Promise((resolve, reject) => {
      let buf = '';
      const t = setTimeout(() => reject(new Error('server receive tidak siap')), 8000);
      child.stdout.on('data', (d) => {
        buf += d.toString();
        const m = /http:\/\/127\.0\.0\.1:\d+\/[a-f0-9]+/.exec(buf);
        if (m) { clearTimeout(t); resolve(m[0]); }
      });
    });
    ok(/\/\w+$/.test(url), 'URL berisi path acak (bukan /)');
    const page = await (await fetch(url)).text();
    ok(/Tempel token Ebox/.test(page), 'halaman form tampil');
    const bad = await (await fetch(url, { method: 'POST', body: new URLSearchParams({ token: '0000|token-palsu-panjang-sekali' }) })).text();
    ok(/❌ server menolak token/.test(bad), 'token palsu ditolak sebelum disimpan');
    const goodTok = '9999|token-uji-dari-hp-yang-cukup-panjang';
    const good = await (await fetch(url, { method: 'POST', body: new URLSearchParams({ token: goodTok }) })).text();
    ok(/✅ Tersimpan/.test(good), 'token valid diterima');
    ok(readFileSync(path.join(dir2, '.ebox-token'), 'utf8').trim() === goodTok, 'token tersimpan ke file');
  } finally {
    child.kill();
    // Tunggu proses anak benar-benar mati sebelum keluar: tanpa ini handle
    // libuv masih menutup saat proses berakhir → assertion UV_HANDLE_CLOSING di
    // Windows dan exit code jadi 127 walau semua assertion lulus.
    if (child.exitCode === null && child.signalCode === null) await once(child, 'exit').catch(() => {});
    rmSync(dir2, { recursive: true, force: true });
  }
  console.log('11. share: memasang sesi di perangkat lain TANPA login baru');
  state.calls.length = 0;
  const sharedTok = '9999|token-berbagi-sesi-yang-panjang';
  r = await run(base, ['share', sharedTok], { dir });
  ok(r.code === 0, 'exit 0');
  const line = (r.stdout || '').split('\n').find((l) => l.startsWith('javascript:'));
  ok(!!line, 'URL javascript: dicetak');
  ok(!state.calls.some((c) => c.url === '/player/login'), 'tidak ada login baru → token lama tidak mati');
  const body = line.slice('javascript:'.length);
  const cookies = [];
  let reloaded = false;
  const stubDoc = { set cookie(v) { cookies.push(v); }, get cookie() { return cookies.join('; '); } };
  const stubLoc = { protocol: 'https:', reload() { reloaded = true; } };
  const stubLs = { data: {}, setItem(k, v) { this.data[k] = String(v); }, getItem(k) { return this.data[k] ?? null; } };
  let evalErr = null;
  try {
    new Function('document', 'location', 'localStorage', 'alert', body)(stubDoc, stubLoc, stubLs, (m) => { evalErr = m; });
  } catch (e) { evalErr = e?.message || String(e); }
  ok(!evalErr, `script jalan di sandbox (${evalErr || 'tanpa error'})`);
  ok(cookies.some((c) => c.startsWith('token=9999%7C')), 'cookie token terisi dengan token yang sama');
  ok(cookies.some((c) => c.startsWith('token_type=Bearer')), 'cookie token_type terisi');
  ok(stubLs.getItem('blindbox_logged_in') === '1', 'flag logged_in di-set (syarat hasAuthSession)');
  ok(reloaded, 'halaman di-reload setelah sesi dipasang');

  console.log('12. share dengan token MATI: ditolak sebelum URL dicetak');
  r = await run(base, ['share', '0000|token-sudah-mati-panjang-sekali'], { dir });
  ok(r.code === 1, 'exit 1');
  ok(/token sudah mati/.test(r.stderr), 'pesan menandakan token mati');
  ok(!/javascript:/.test(r.stdout), 'URL tidak dicetak (tidak memberi ilusi sesi aktif)');
} finally {
  server.close();
  rmSync(dir, { recursive: true, force: true });
}

console.log(failures ? `\n❌ ${failures} gagal` : '\n✅ semua lulus');
process.exitCode = failures ? 1 : 0;
