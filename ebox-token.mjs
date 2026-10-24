#!/usr/bin/env node
/*
 * ebox-token.mjs — ambil token Ebox (ebox.zone) TANPA buka DevTools.
 *
 * Kenapa script ini ada:
 *   Web ebox.zone menyimpan sesi di cookie `token` (dan `token_type`), lalu
 *   mengirimnya sebagai header `Authorization: Bearer <token>`. Cookie itu
 *   tidak HttpOnly (dibuat lewat document.cookie), tapi kalau klik-kanan /
 *   F12 / "Inspect" diblokir, cara paling praktis adalah login langsung ke
 *   API-nya — endpoint login-nya publik dan tidak pakai captcha.
 *
 * Identitas akun di Ebox adalah NOMOR TELEPON, bukan email:
 *   - Form web memakai type=1 (telepon) + auth_method=1 (OTP SMS).
 *   - Akun yang dibuat lewat telepon punya `email: null`; akun yang dibuat
 *     lewat email punya `phone_no: null`. Keduanya akun terpisah.
 *   - Login dengan email yang tidak terdaftar = AKUN BARU, bukan gagal.
 *     Jadi kalau akunmu pakai telepon, login pakai email akan membuat akun
 *     kosong yang berbeda — bukan membuka akunmu.
 *
 * API (hasil bedah bundle Next.js di www.ebox.zone):
 *   base   https://admin.ebox.zone/api
 *   auth   Authorization: Bearer <token>        (token = cookie `token`)
 *   login  POST /player/login  multipart:
 *            type=1 (phone) | 2 (email)
 *            auth_method=1 (OTP) | 2 (password)
 *            phone_code, phone_no, otp | password   (atau email)
 *   otp    POST /send-otp      {type, phone_code, phone_no}
 *   cek    POST /player/profile
 *   saldo  POST /player/wallet-balance
 *
 * Pemakaian:
 *   node ebox-token.mjs phone 08123456789 <password>  # telepon + password
 *   node ebox-token.mjs otp   08123456789             # kirim OTP, lalu ketik kodenya
 *   node ebox-token.mjs otp   08123456789 --code 123456
 *   node ebox-token.mjs login <email> <password>      # akun yang memang pakai email
 *   node ebox-token.mjs check                         # verifikasi token tersimpan
 *   node ebox-token.mjs cookie "token=...; token_type=Bearer"
 *   node ebox-token.mjs bookmarklet                   # URL javascript: untuk address bar
 *   node ebox-token.mjs receive                       # halaman LAN untuk tempel token dari HP
 *
 * Login dari device lain mematikan token bot (satu sesi per akun), TAPI satu
 * token boleh dipakai banyak device sekaligus. Jadi login sekali di HP, ambil
 * tokennya, kirim ke PC lewat `receive` atau `cookie` — bukan login dua kali.
 *
 * Token disimpan di .ebox-token (mode 600) dan TIDAK boleh di-commit.
 */

import { readFileSync, writeFileSync, existsSync, chmodSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline/promises';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const API = (process.env.EBOX_API_BASE || 'https://admin.ebox.zone/api').replace(/\/$/, '');
// EBOX_TOKEN_FILE boleh absolut (dipakai tes); path.join dengan nilai absolut
// akan menghasilkan path ngawur seperti "<proyek>\C:\Users\...".
const TOKEN_FILE = (() => {
  const f = process.env.EBOX_TOKEN_FILE || '.ebox-token';
  return path.isAbsolute(f) ? f : path.join(__dirname, f);
})();
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

const argv = process.argv.slice(2);
const [cmd, ...rest] = argv;

// Jangan pakai process.exit() di tengah fetch: di Windows (libuv) itu memicu
// assertion `UV_HANDLE_CLOSING` dan exit code-nya jadi 127, bukan 1. Lempar
// error, biar satu handler di bawah yang mengatur exit code.
const fail = (msg) => { throw new Error(msg); };

function readSaved() {
  if (!existsSync(TOKEN_FILE)) return null;
  const t = readFileSync(TOKEN_FILE, 'utf8').trim();
  return t || null;
}

function save(tok) {
  writeFileSync(TOKEN_FILE, tok + '\n', { mode: 0o600 });
  try { chmodSync(TOKEN_FILE, 0o600); } catch { /* Windows: abaikan */ }
  return TOKEN_FILE;
}

/* Terima 0812..., 812..., 62812..., +62 812-3456-7890 → {phoneCode, phoneNo}.
 * Salah normalisasi = akun salah, jadi ini dibuat ketat dan bisa dites. */
function normalizePhone(input) {
  const raw = String(input ?? '').replace(/[\s\-().]/g, '');
  if (!/^\+?\d{8,15}$/.test(raw)) return null;
  let digits = raw.replace(/^\+/, '');
  if (digits.startsWith('62')) digits = digits.slice(2);
  else if (digits.startsWith('0')) digits = digits.slice(1);
  if (digits.length < 8) return null;
  return { phoneCode: '+62', phoneNo: digits };
}

const looksLikePhone = (v) => normalizePhone(v) !== null && !String(v).includes('@');

async function call(pathname, tok, body) {
  const res = await fetch(`${API}${pathname}`, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'User-Agent': UA,
      ...(tok ? { Authorization: /^Bearer\s/i.test(tok) ? tok : `Bearer ${tok}` } : {}),
    },
    body,
    signal: AbortSignal.timeout(20000),
  });
  let data = null;
  try { data = await res.json(); } catch { /* bukan JSON */ }
  return { status: res.status, data };
}

async function profile(tok) {
  const { status, data } = await call('/player/profile', tok);
  if (status !== 200 || !data?.status) {
    const why = data?.message || `HTTP ${status}`;
    fail(`token ditolak — ${why}`);
  }
  const u = data.data?.user || {};
  const bal = await call('/player/wallet-balance', tok);
  const amount = bal.data?.data?.amount;
  console.log('✓ token valid');
  console.log(`  id        ${u.id ?? '?'}  (${u.id_number ?? '-'})`);
  console.log(`  nama      ${u.name ?? '?'}`);
  console.log(`  email     ${u.email ?? '-'}`);
  console.log(`  telepon   ${u.phone_no ? `${u.phone_code ?? ''}${u.phone_no}` : '-'}`);
  console.log(`  level     ${data.data?.level?.level_name ?? '?'}`);
  console.log(`  saldo     ${amount != null ? `${u.currency_symbol ?? ''}${amount}` : '(gagal ambil)'}`);
}

/* Login apa pun lewat satu jalur: kirim form, kalau sukses simpan token.
 * `kind` cuma dipakai untuk pesan peringatan akun baru — dan peringatannya
 * beda: email salah ketik bikin akun baru, telepon salah ketik juga bikin
 * akun baru yang sama sekali tidak ada hubungannya dengan akunmu. */
async function submitLogin(form, { kind }) {
  const { status, data } = await call('/player/login', null, form);
  if (status !== 200 || !data?.status) fail(`login gagal — ${data?.message || `HTTP ${status}`}`);
  if (data.data?.is_new_user) {
    console.error(`! ${kind} ini belum terdaftar — Ebox membuat AKUN BARU, bukan membuka akun lama.`);
    console.error('  Kalau ini bukan maksudmu, berarti nomor/emailnya salah. Cek dulu sebelum lanjut.');
  }
  const tok = data.data?.token;
  if (!tok) fail('server tidak mengirim token');
  const saved = save(tok);
  console.error('! login menerbitkan token baru — sesi lain (browser) langsung mati (401).');
  console.log(`✓ token tersimpan di ${saved}`);
  console.log(tok);
  await profile(tok);
}

function phoneForm({ phoneCode, phoneNo }, { password, otp }) {
  const f = new FormData();
  f.set('type', '1');
  f.set('auth_method', password ? '2' : '1');
  f.set('phone_code', phoneCode);
  f.set('phone_no', phoneNo);
  f.set('email', '');
  if (password) f.set('password', password);
  else f.set('otp', String(otp));
  return f;
}

function emailForm(email, password) {
  const f = new FormData();
  f.set('type', '2');
  f.set('auth_method', '2');
  f.set('email', email.trim());
  f.set('phone_code', '+62');
  f.set('phone_no', '');
  f.set('password', password);
  return f;
}

async function loginByPhone(phoneInput, password) {
  const p = normalizePhone(phoneInput);
  if (!p) fail(`nomor tidak dikenali: ${phoneInput} (contoh: 08123456789)`);
  console.log(`→ login telepon ${p.phoneCode}${p.phoneNo}`);
  await submitLogin(phoneForm(p, { password }), { kind: 'nomor' });
}

async function loginByOtp(phoneInput, { code = null, send = true } = {}) {
  const p = normalizePhone(phoneInput);
  if (!p) fail(`nomor tidak dikenali: ${phoneInput} (contoh: 08123456789)`);

  if (send) {
    const sent = await call('/send-otp', null, phoneForm(p, { otp: '' }));
    if (sent.status !== 200 || !sent.data?.status) fail(`gagal kirim OTP — ${sent.data?.message || `HTTP ${sent.status}`}`);
    console.log(`✓ OTP dikirim ke ${p.phoneCode}${p.phoneNo}${sent.data?.data?.is_new_user ? ' (nomor ini belum terdaftar — akan jadi akun baru)' : ''}`);
  }

  let otp = code;
  if (!otp) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    try {
      otp = (await rl.question('kode OTP dari SMS: ')).trim();
    } finally {
      rl.close();
    }
    if (!/^\d{4,8}$/.test(otp)) fail('kode OTP harus 4–8 digit');
  }

  await submitLogin(phoneForm(p, { otp }), { kind: 'nomor' });
}

/* Server kecil di LAN: HP membuka URL-nya, menempel token, PC yang menyimpan.
 *
 * Kenapa perlu: token hanya bisa diambil dari browser yang sedang login, dan
 * mengetik token 60+ karakter di HP itu menyiksa. Dengan ini alurnya cuma
 * "tempel di HP → selesai", dan token divalidasi dulu ke /player/profile
 * sebelum ditulis, jadi token sampah tidak pernah menimpa .ebox-token.
 *
 * Hanya menerima PUT token, tidak pernah menampilkan token yang tersimpan.
 * Path-nya acak supaya orang lain di WiFi yang sama tidak bisa menebak. */
async function receiveToken(args) {
  const { createServer } = await import('node:http');
  const { networkInterfaces } = await import('node:os');
  const crypto = await import('node:crypto');

  const portArg = args.find((a) => /^\d+$/.test(a));
  const port = Number(portArg || process.env.EBOX_RECEIVE_PORT || 8787);
  const secret = crypto.randomBytes(6).toString('hex');
  const stay = args.includes('--stay');

  const page = (msg = '') => `<!doctype html><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Tempel token Ebox</title>
<style>body{font:16px system-ui;margin:0;padding:20px;background:#111;color:#eee}
textarea{width:100%;height:110px;font:13px monospace;padding:8px;box-sizing:border-box}
button{margin-top:10px;padding:12px 18px;font-size:16px;width:100%}
p{line-height:1.45}code{background:#222;padding:2px 5px;border-radius:4px}</style>
<h3>Tempel token Ebox</h3>${msg}
<form method="POST">
<textarea name="token" placeholder="token=... atau tempel token saja" autofocus></textarea>
<button type="submit">Simpan ke PC</button>
</form>
<p><small>Ambil token di HP: buka ebox.zone (sudah login), jalankan bookmarklet
<code>javascript:prompt('token',document.cookie.match(/(?:^|; )token=([^;]*)/)?.[1])</code>,
salin hasilnya, lalu tempel di atas.</small></p>`;

  const server = createServer((req, res) => {
    const url = req.url.split('?')[0];
    if (url !== `/${secret}`) { res.writeHead(404); res.end('not found'); return; }

    if (req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(page());
      return;
    }
    if (req.method !== 'POST') { res.writeHead(405); res.end('method not allowed'); return; }

    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', async () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      const body = new URLSearchParams(raw).get('token') || raw;
      const m = /(?:^|[;\s])token=([^;]+)/.exec(body);
      const tok = decodeURIComponent((m ? m[1] : body).trim().replace(/^"|"$/g, ''));
      const failHtml = (why) => {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(page(`<p style="color:#f66">❌ ${why}</p>`));
      };
      if (!tok || tok.length < 20) return failHtml('token kelihatan kosong/terlalu pendek');

      try {
        const p = await call('/player/profile', tok);
        if (p.status !== 200 || !p.data?.status) return failHtml(`server menolak token (${p.data?.message || p.status})`);
        const u = p.data.data?.user || {};
        save(tok);
        console.log(`✓ token diterima dari ${req.socket.remoteAddress} — ${u.name || '?'} (id ${u.id ?? '?'}), tersimpan di ${TOKEN_FILE}`);
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(page(`<p style="color:#6f6">✅ Tersimpan: <b>${u.name || '?'}</b> (id ${u.id ?? '?'}, Level ${p.data.data?.level?.level_name || '?'})</p><p>Boleh tutup tab ini.</p>`));
        if (!stay) setTimeout(() => server.close(() => process.exit(0)), 700);
      } catch (e) {
        failHtml(e?.message || String(e));
      }
    });
  });

  // Jangan pernah tertinggal hidup: server ini membuka port ke LAN dan tidak
  // ada gunanya setelah token diterima. 10 menit cukup untuk login + tempel.
  const lifeMs = Number(process.env.EBOX_RECEIVE_TIMEOUT_MS || 10 * 60e3);
  const timer = setTimeout(() => {
    const human = lifeMs >= 60000 ? `${Math.round(lifeMs / 60000)} menit` : `${Math.round(lifeMs / 1000)} detik`;
    console.log(`\n⌛ ${human} tanpa token — server ditutup.`);
    server.close(() => process.exit(1));
  }, lifeMs);
  server.on('close', () => clearTimeout(timer));

  server.listen(port, '0.0.0.0', () => {
    const ips = Object.values(networkInterfaces()).flat()
      .filter((i) => i && i.family === 'IPv4' && !i.internal).map((i) => i.address);
    console.log('Menunggu token dari HP (Ctrl+C untuk batal)...');
    console.log(`  di PC ini : http://127.0.0.1:${port}/${secret}`);
    for (const ip of ips) console.log(`  di HP     : http://${ip}:${port}/${secret}   <- buka ini (WiFi sama)`);
    if (!ips.length) console.log('  (tidak ada IP LAN — HP harus satu jaringan dengan PC ini)');
  });
}

async function main() {
  if (cmd === 'login' || cmd === 'phone') {
    const [who, password] = rest;
    if (!who || !password) fail(`pakai: node ebox-token.mjs ${cmd} <${cmd === 'phone' ? 'nomor telepon' : 'email'}> <password>`);
    // `login` sengaja ikut mengenali nomor: orang biasanya cuma ingat "login".
    if (cmd === 'phone' || looksLikePhone(who)) {
      if (cmd === 'login') console.error('(argumen berbentuk nomor telepon — memakai jalur telepon)');
      await loginByPhone(who, password);
    } else {
      await submitLogin(emailForm(who, password), { kind: 'email' });
    }
  } else if (cmd === 'otp') {
    const idx = rest.indexOf('--code');
    const code = idx >= 0 ? rest[idx + 1] : null;
    // Tanpa --code, idx = -1: jangan sampai filter indeks ini membuang nomor
    // di posisi 0 (bug yang bikin `otp <nomor>` selalu minta argumen).
    const phone = idx >= 0 ? rest.filter((_, i) => i !== idx && i !== idx + 1)[0] : rest[0];
    if (!phone) fail('pakai: node ebox-token.mjs otp <nomor> [--code 123456]');
    if (idx >= 0 && !/^\d{4,8}$/.test(String(code))) fail('--code harus 4–8 digit');
    await loginByOtp(phone, { code, send: idx < 0 });
  } else if (cmd === 'check') {
    const tok = rest[0] || readSaved();
    if (!tok) fail('belum ada token tersimpan; jalankan: node ebox-token.mjs otp <nomor>');
    await profile(tok);
  } else if (cmd === 'cookie') {
    const raw = rest.join(' ');
    if (!raw) fail('pakai: node ebox-token.mjs cookie "token=...; token_type=Bearer"');
    const tok = /(?:^|[;\s])token=([^;]+)/.exec(raw)?.[1];
    if (!tok) fail('tidak ada cookie bernama "token" di string itu');
    const decoded = decodeURIComponent(tok.trim());
    save(decoded);
    console.log('✓ token dari cookie tersimpan');
    await profile(decoded);
  } else if (cmd === 'bookmarklet') {
    // Dipakai kalau DevTools diblokir: drag ke bookmark bar, atau ketik "javascript:" manual
    // di address bar (browser membuang prefix itu saat paste).
    const js = "javascript:(()=>{const m=document.cookie.match(/(?:^|; )token=([^;]*)/);"
      + "prompt('Token Ebox (salin semua):',m?decodeURIComponent(m[1]):'TIDAK ADA — login dulu')})()";
    console.log(js);
    console.log('\nCara pakai: buka ebox.zone sambil login, lalu jalankan URL di atas.');
    console.log('Kalau browser membuang "javascript:" saat di-paste, ketik ulang 11 huruf itu manual.');
  } else if (cmd === 'share') {
    let tok = rest[0] || readSaved();
    if (!tok) fail('belum ada token tersimpan; jalankan: node ebox-token.mjs otp <nomor>');
    // Validasi dulu: memasang token yang sudah mati justru memberi kesan
    // "device lain sudah login" padahal sesinya kosong. Lebih baik berhenti
    // dengan pesan jelas daripada mengirim URL yang tidak berguna.
    const v = await call('/player/profile', tok);
    if (v.status !== 200 || !v.data?.status) {
      fail(`token sudah mati (${v.data?.message || `HTTP ${v.status}`}) — dapat token baru dulu: ` +
        'node ebox-token.mjs otp <nomor>, atau tempel lewat `receive` dari device yang masih login.');
    }
    tok = String(tok).trim();
    // Batas server itu "satu token aktif", BUKAN "satu perangkat". Login baru di
    // perangkat mana pun membunuh token lama, sedangkan memasang token yang SAMA
    // di perangkat lain tidak membatalkan apa pun (terbukti: satu token dipakai
    // dari beberapa User-Agent sekaligus → 200 semua). Jadi kunci multi-device
    // adalah MENYALIN sesi, bukan MEMBUAT sesi baru.
    const js = 'javascript:(()=>{try{'
      + 'const t=decodeURIComponent("' + encodeURIComponent(tok) + '");'
      + "const s=';path=/;max-age=31536000;SameSite=Lax'+(location.protocol==='https:'?';Secure':'');"
      + "document.cookie='token='+encodeURIComponent(t)+s;"
      + "document.cookie='token_type=Bearer'+s;"
      + "try{localStorage.setItem('blindbox_logged_in','1')}catch(e){}"
      + 'location.reload();}catch(e){alert("gagal: "+e)}})()';
    console.log(js);
    console.log('\nCara pakai: di perangkat lain, buka ebox.zone lalu tempel URL ini di address bar');
    console.log('(ketik manual "javascript:" kalau browser membuangnya saat paste).');
    console.log('Perangkat itu langsung masuk sesi dengan token yang SAMA — tanpa login baru,');
    console.log('jadi token bot TIDAK mati dan HP tetap terbuka.');
    console.log('\n⚠ URL ini MEMUAT token: jangan dibagikan, jangan di-commit, hapus dari riwayat setelah dipakai.');
  } else if (cmd === 'receive') {
    await receiveToken(rest);
  } else {
    console.log(readFileSync(fileURLToPath(import.meta.url), 'utf8').split('*/')[0].replace(/^#!.*\n/, ''));
    if (cmd) process.exitCode = 1;
  }
}

main().catch((e) => {
  console.error(`✗ ${e?.message || e}`);
  process.exitCode = 1;
});
