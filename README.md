# ebox-bot — catatan API ebox.zone

Situs `https://www.ebox.zone/ebox/home` adalah blind-box seperti Boxkia. Halaman
"home"-nya butuh login, dan DevTools sering tidak bisa dibuka. Untungnya
autentikasinya sederhana — tidak perlu inspect apa pun.

## Ringkas: token ada di cookie

| Hal | Nilai |
|---|---|
| Disimpan di | cookie `token` (dan `token_type`, biasanya `Bearer`) |
| Dikirim sebagai | header `Authorization: Bearer <token>` |
| Sifat cookie | **tidak HttpOnly** — bisa dibaca `document.cookie` |
| Format token | `<id>|xxxxxxxx...` — Laravel Sanctum (`id|plaintext`), `id` naik tiap login |
| Masa berlaku | tidak kedaluwarsa sendiri, **tapi login baru mematikan token lama** (lihat bawah) |

API: `https://admin.ebox.zone/api` — endpoint di catatan ini semuanya `POST`,
body `multipart/form-data` atau JSON tergantung endpoint.

> **Satu sesi aktif per akun.** Setiap login (dari script *maupun* dari browser)
> menerbitkan token baru dan **token sebelumnya langsung mati** — terbukti:
> token `3207` yang tadinya valid jadi `401` begitu `3209` terbit. Ini yang di
> frontend disebut "session takeover". Konsekuensinya untuk bot: jangan login
> di browser selama bot jalan, dan sebaliknya. Ambil token sekali, simpan di
> `.ebox-token`, pakai terus.

Kalau token hilang / sesi mati: `POST /player/profile` menjawab
`401 {"message":"Invalid or expired token."}`.

**Login dari device lain ikut mematikan token bot.** Dibuktikan dengan dua login
berurutan (User-Agent desktop lalu Android): token desktop `3217` → `401`
setelah token HP `3218` terbit. Header `platform` **tidak** membantu membuat
sesi paralel — semua nilai yang dicoba (`web`, `app`, `ios`, `android`, `wap`,
`h5`, `mobile`) dijawab `422 The selected platform is invalid.` Jadi satu akun
= satu sesi aktif; tidak ada cara resmi punya dua.

Sebaliknya, **memakai** token (bot klaim tiap jam) tidak menerbitkan token baru,
jadi rutin bot tidak akan menendang kamu keluar dari browser. Hanya *login*
yang melakukannya.

## Multi-device: salin sesi, jangan bikin login baru

Jadi batasnya bukan "satu perangkat" — melainkan **satu token**. Perangkat sebanyak
apa pun boleh memakai token yang sama. Yang dilarang server cuma *login kedua*.

```bash
node ebox-token.mjs share        # cetak URL javascript: berisi token aktif
```

Di device lain: buka `ebox.zone` → tempel URL itu di address bar → sesi terpasang
langsung, **tanpa melewati login**, jadi token bot tidak mati. Ini satu-satunya
jalur ke "dua perangkat online" yang tidak membatalkan sesi lain.

Mencari celah lain untuk dua token aktif sekaligus sudah dicoba dan tidak ada:

| Percobaan | Hasil |
|---|---|
| Login dua kali dengan User-Agent berbeda | token pertama → `401` |
| Header `platform` (dipakai app mobile) | 20+ nilai dicoba, semua `422 The selected platform is invalid` |
| Login tanpa `platform` | sama saja — token lama tetap mati |

Jalur sah untuk tetap punya dua sesi sekaligus: **pakai akun berbeda**.

⚠ Perintah `share` **mencetak token**. Jangan dibagikan, jangan di-commit, dan
hapus dari riwayat browser setelah dipakai.

## Kenapa web-nya minta nomor telepon, bukan email

Karena **identitas akun Ebox adalah nomor telepon**. Form web mengirim
`type=1` + `auth_method=1` (OTP SMS). Email cuma jalur alternatif yang hasilnya
**akun berbeda**:

| Dibuat dengan | `email` | `phone_no` |
|---|---|---|
| Nomor telepon (form web) | `null` | terisi |
| Email | terisi | `null` |

Jadi kalau akunmu dibuat lewat nomor, **login pakai email tidak akan membuka
akun itu** — server menganggap email itu belum terdaftar lalu **membuat akun
baru yang kosong**. Ini bukan error yang kelihatan: login-nya sukses, tapi kamu
masuk ke akun lain (id, level, saldo semuanya beda).

## Cara mengambil token

### 1. Tanpa browser sama sekali (paling praktis)

```bash
node ebox-token.mjs otp 08123456789                 # kirim OTP SMS, lalu ketik kodenya
node ebox-token.mjs otp 08123456789 --code 123456   # kalau kode sudah ada
node ebox-token.mjs phone 08123456789 <password>    # kalau akun punya password
```

`otp` memanggil `POST /send-otp` lalu `POST /player/login` (`type=1`,
`auth_method=1`); `phone` memakai `auth_method=2`. Keduanya menyimpan token ke
`.ebox-token` dan langsung memverifikasinya lewat `/player/profile`.
Normalisasi nomor otomatis: `0812-3456-7890`, `+62 812 3456 7890`, dan
`6281234567890` semuanya jadi `+62` + `81234567890`.

Untuk akun yang memang dibuat pakai email:

```bash
node ebox-token.mjs login <email> <password>
```

`login` ikut mengenali bentuk nomor telepon dan otomatis pindah ke jalur
telepon, supaya tidak ada yang tanpa sadar bikin akun baru karena salah jalur.

> **Akun baru selalu diberitahukan.** Kalau nomor/email belum terdaftar,
> server menjawab `is_new_user: true` dan script mencetak peringatan tegas —
> bukan diam-diam menerbitkan token untuk akun kosong.

### 2. Bookmarklet (kalau tetap mau ambil dari browser yang sudah login)

```bash
node ebox-token.mjs bookmarklet
```

Salin URL `javascript:...` yang keluar, buka ebox.zone sambil login, lalu
jalankan di address bar. Browser membuang prefix `javascript:` saat paste —
ketik ulang manual. Hasilnya muncul di `prompt()`: token siap disalin.

Lalu verifikasi:

```bash
node ebox-token.mjs cookie "token=<paste>; token_type=Bearer"
```

### 3. curl langsung

```bash
# telepon + password
curl -X POST https://admin.ebox.zone/api/player/login \
  -F 'type=1' -F 'auth_method=2' \
  -F 'phone_code=+62' -F 'phone_no=81234567890' \
  -F 'password=rahasia'

# telepon + OTP (minta kode dulu)
curl -X POST https://admin.ebox.zone/api/send-otp \
  -F 'type=1' -F 'phone_code=+62' -F 'phone_no=81234567890'
curl -X POST https://admin.ebox.zone/api/player/login \
  -F 'type=1' -F 'auth_method=1' \
  -F 'phone_code=+62' -F 'phone_no=81234567890' -F 'otp=123456'
```

`type`: `1` = telepon, `2` = email. `auth_method`: `1` = OTP, `2` = password.
Field yang tidak dipakai tetap dikirim kosong (`email=` untuk jalur telepon).

## Endpoint yang relevan untuk bot harian

| Endpoint | Fungsi |
|---|---|
| `POST /player/profile` | user + level + exp (butuh token) |
| `POST /player/wallet-balance` | saldo |
| `POST /player/daily-box-listing` | daftar "Daily Blind Box" per level (`is_locked`, `is_available`, `next_available_at`) |
| `POST /player/daily-box-sub-product-listing` | isi box + peluang grade, JSON body `{main_product_id}` |
| `POST /player/redeem-free-draw` | klaim free draw harian, body `main_product_id` = `free_draw_product_id` |
| `POST /player/redeem-daily-box` | klaim box harian per level, body `main_product_id` = id box dari listing |
| `POST /player/draw-history` | riwayat draw — **satu-satunya tempat nama hadiah** (`sub_product_name`) |
| `POST /player/daily-point-state` | status poin harian (`is_available`, `next_claim_available_from`, `claim_hour`) |
| `POST /player/daily-point-claim` | klaim poin harian |
| `POST /player/free-draw-state` | status draw gratis |
| `POST /player/point-history` | riwayat poin (body `{page, per_page}`) |
| `POST /player/free-hunt-session-listing` | daftar sesi Treasure Hunt hari itu (body JSON `{date}` — **tanggal server/UTC**) |
| `POST /player/free-hunt-session-detail` | detail satu sesi (body form `session_id`) |
| `POST /player/free-hunt-join` | ikut sesi Treasure Hunt (body form `session_id`) |

Padanan dengan Boxkia: `daily-box-listing` ≈ `freeBlindBox/detail`, dan
`redeem-free-draw` ≈ `freeBlindBox/submit`. Bedanya di sini box dikunci per
level (Lv2, Lv11, Lv21, ...) dan syaratnya `min_level_id`, bukan `blind_box_id`
tunggal.

## Keamanan

- Token = akses penuh akun (termasuk withdraw). Jangan ditempel di chat,
  jangan di-commit. `.ebox-token` sudah masuk `.gitignore` dan diset mode `600`
  di Linux/macOS (di Windows `chmod` diabaikan, jadi andalkan `.gitignore`).
- File ini hanya berisi endpoint publik + tool pengambil token; tidak ada
  kredensial di dalamnya.

---

# Automasi harian (`ebox-daily.mjs`)

Padanan `freebox-draw.mjs` di boxkia-bot, tapi alurnya beda: di Ebox **free
draw harian bukan bagian dari daftar daily box**. Free draw punya state sendiri:

```json
POST /player/free-draw-state
{ "status": true, "data": {
    "entitled": true, "remaining_free_draw": 1,
    "has_redeemed": false, "free_draw_product_id": 110 } }
```

Klaimnya `POST /player/redeem-free-draw` dengan **`main_product_id` =
`free_draw_product_id`**, dan jawabannya berisi hadiahnya:

```json
{ "status": true, "data": {
    "main_product_id": 110, "sub_product_name": "Prize - Rp35000",
    "amount": "35.000000" },
  "message": "Free draw redeemed successfully." }
```

Sesudah redeem, state berubah jadi `entitled:false, remaining_free_draw:0,
has_redeemed:true` — itulah yang membuat bot aman dijalankan tiap jam
(idempoten, tidak dobel klaim).

## Yang dikerjakan tiap run

| Langkah | Aksi |
|---|---|
| `free-draw-state` → `redeem-free-draw` | klaim free draw kalau `remaining_free_draw > 0 && !has_redeemed` |
| `daily-point-state` → `daily-point-claim` | klaim poin harian kalau `is_available` |
| `daily-box-listing` → `redeem-daily-box` | klaim box harian yang `is_available` (gratis, `draw_amount: 0`) |
| `free-hunt-session-listing` → `free-hunt-join` | ikut Treasure Hunt yang level-nya terpenuhi dan sesinya sudah `can_join` |

Box diklaim hanya kalau **dua** syarat server terpenuhi: `is_available: true`
dan `is_locked: false`. Box level yang lebih tinggi cuma dilaporkan.

Respons `redeem-daily-box` **tidak memuat nama hadiah** — hanya status. Nama
item diambil dari `POST /player/draw-history` (entri terbaru dengan
`main_product_name` yang cocok). Ini terbukti di akun asli: klaim Lv2 menjawab
`status: true` tanpa detail, sementara riwayat mencatat
`sub_product_name: "Ebox Cash Voucher", amount: 0.45, grade R`.

## Treasure Hunt ("free hunt") — jendela cuma 10 menit

Sesi berbasis level (`type: 1`) buka tiap jam dan **hanya bisa diikuti 10
menit**: `open_at` 05:00 UTC lalu diundi 05:10 UTC — yaitu **12:00–12:10 WIB**
untuk sesi `V2` (syarat Level 2). Sebelum jam buka server menolak:

```json
POST /player/free-hunt-join   → 422
{ "status": false, "message": "This Treasure Hunt session has not opened yet." }
```

Karena jadwal per jam (menit `:53`) selalu jatuh di luar jendela itu, langkah
ini punya jadwal sendiri: `--hunt-only` tiap menit 11:58–12:13.

Syarat ikut yang dipakai bot: `type === 1`, `level_name` ≤ level akun,
`is_joined === false`, kuota belum penuh, dan `can_join: true` — field yang
sama yang menyalakan tombol BERGABUNG di web. Rain Pool (`type: 2`) dilewati
karena syaratnya `min_spend` hari itu.

Untuk akun Level 5 hari ini hanya ada satu sesi yang relevan:
`V2 Treasure Hunt` (Level 2, hadiah RC Drift Car, 270 slot). Sesi V10/V20/V30
tidak pernah dicoba karena levelnya belum tercapai.

## Pakai

```bash
node ebox-daily.mjs            # klaim + notif kalau ada aksi
node ebox-daily.mjs --hunt-only # hanya Treasure Hunt (dipakai jadwal menit-an)
node ebox-daily.mjs --await     # tunggu detik buka lalu join (dipakai GitHub Actions)
node ebox-daily.mjs --check    # lihat status saja, tidak menulis
node ebox-daily.mjs --json     # keluaran JSON (untuk diparse)
node test-ebox-token.mjs       # 44 assertion: routing telepon/email, OTP, receive, share
node test-ebox-daily.mjs       # 66 assertion: klaim, hunt, mode --await, notif
```

Token dibaca dari `EBOX_TOKEN` → `config.json` (`accounts[0].token`) →
`.ebox-token`. Notif lewat `ntfyTopic` (config) atau `EBOX_NTFY_TOPIC`.

## Dua cara menjalankan

| Cara | Laptop | Kelebihan | Kekurangan |
|---|---|---|---|
| Task Scheduler lokal | harus **menyala** | RTT ke server Jakarta paling kecil | jam 12:00 terlewat kalau laptop tidur |
| GitHub Actions ([ACTIONS.md](ACTIONS.md)) | boleh **mati** | jalan terus di cloud, `--await` menunggu detik buka | runner di US/EU, ~200–400 ms lebih lambat |

Keduanya boleh aktif bersamaan: klaim/join-nya idempoten, dan yang sudah
dikerjakan tidak memicu notif kedua.

## Jadwalkan (Windows, lokal)

Windows (Task Scheduler, tiap jam) — jalankan sekali dari Command Prompt:

```bat
install-schedule.cmd
```

Atau manual:

```powershell
schtasks /Create /SC HOURLY /TN "Ebox Daily" /TR "C:\home\user\ebox-bot\run-ebox-daily.cmd" /F
```

Hapus jadwal: `schtasks /Delete /TN "Ebox Daily" /F`.
Jalankan di luar jadwal: `Start-ScheduledTask -TaskName 'Ebox Daily'`.

Treasure Hunt butuh jadwal terpisah karena jendelanya cuma 10 menit
(`--hunt-only`, tiap menit 11:58–12:13 WIB):

```powershell
schtasks /Create /SC DAILY /TN "Ebox Hunt" /TR "C:\home\user\ebox-bot\run-ebox-hunt.cmd" /ST 11:58 /RI 1 /DU 00:15 /F
```

Hapus: `schtasks /Delete /TN "Ebox Hunt" /F`.

Linux/VPS (cron, tiap jam):

```cron
0 * * * * cd /path/ebox-bot && /usr/bin/node ebox-daily.mjs >> ebox-daily.out.log 2>&1
```

Jangan menjadwalkan lebih sering dari tiap 15 menit: kuota harian tidak
bertambah, dan tiap run tetap 3 request ke server mereka.

## Notifikasi ntfy

Bot mengirim pesan ke ntfy.sh saat **ada aksi** (hadiah, poin diklaim) atau
**ada error non-jaringan** (mis. sesi mati). Kondisi gagal yang menetap dibungkam
jeda 6 jam, dan `--check` tidak pernah mengirim apa pun.

```json
// config.json (gitignored)
{ "ntfyTopic": "ebox-alert-xxxxxxxxxxxx" }
```

Di HP: pasang app **ntfy** (Play Store/App Store) → Add subscription → topic
sama persis dengan yang ada di config. Bisa juga diset lewat env:
`EBOX_NTFY_TOPIC`.

> **Nama topik itu seperti kata sandi.** Siapa pun yang mengetahui topikmu bisa
> membaca (dan mengirim) ke topik itu. Jangan dibagikan, dan jangan di-commit.

Bukti pengiriman bot → ntfy (uji sungguhan, bukan mock):

```
{"event":"message","topic":"ebox-alert-…","title":"⚠️ Ebox: ada masalah",
 "message":"🔑 free-draw: sesi mati — ambil token baru\n🔑 point: …\n🔑 boxes: …"}
```

## Yang sudah diuji vs belum

- ✅ **Login telepon sungguhan** (di akun uji): `phone 81234567890 <password>`
  masuk ke akun yang sama — `email: null`, `phone_no: +6281234567890`.
- ✅ **OTP sungguhan**: `POST /send-otp` menjawab `200`, dan login dengan kode
  salah ditolak `422 Invalid OTP` — artinya field-nya benar, bukan salah nama.
- ✅ **Redeem sungguhan, dijalankan oleh bot ini sendiri** (bukan curl):
  `node ebox-daily.mjs` → `🎁 free-draw: Prize - Rp35000`; run kedua →
  `⏳ sudah draw hari ini`, tanpa request klaim.
- ✅ `--check` tidak menulis apa pun (diperiksa dari request yang masuk ke
  server tiruan).
- ✅ Token mati (401) dilaporkan "sesi mati — ambil token baru", bukan crash
  dan bukan "gangguan jaringan".
- ✅ Error 500 server tidak disalahartikan sebagai token mati.
- ✅ **Notif ntfy**: terkirim tepat satu saat ada aksi (topic + isi hadiah
  diperiksa), tidak dikirim saat tidak ada aksi, kondisi gagal yang menetap
  dibungkam jeda 6 jam, dan `--check` selalu diam — semuanya lawan server
  ntfy tiruan.
- ✅ **Klaim box daily per level, sungguhan** di akun Level 2:
  `🎁 Daily Blind Box - Lvl 2 → Ebox Cash Voucher (0.45)`; listing sesudahnya
  jadi `available: false, locked: false`, dan run berikutnya tidak menembak lagi.
- ✅ **Jadwal Windows** berjalan: `Start-ScheduledTask` → `LastTaskResult: 0`,
  log baru tertulis sebagai akun asli (bukan akun uji).
- ✅ **Treasure Hunt, jalur baca**: `--hunt-only` di akun asli menjawab
  `⏳ hunt: V2 Treasure Hunt: buka 12.00` (jam buka sudah dikonversi ke WIB)
  dan tidak menembak join sebelum waktunya.
- ✅ **Join sebelum buka ditolak server**: `POST /player/free-hunt-join`
  dijawab `422 This Treasure Hunt session has not opened yet.` — jadi percobaan
  lebih awal memang aman, bukan klaim palsu.
- ✅ Jalur join yang berhasil, "sudah ikut" (tidak dobel notif), kuota penuh, dan
  sesi Level 30 yang dilewati semuanya diuji lawan server tiruan.
- ⬜ **Join sungguhan saat 12:00 WIB** belum terjadi — jadwalnya baru terpasang
  dan akan terbukti pada run pertama di jam itu.
- ⬜ **Klaim poin** belum pernah jalan di server asli — jadwal per jam baru akan
  menangkapnya setelah jam 12:00 WIB. Jalur ini hanya teruji di server tiruan.

---

# Login di HP tanpa merusak bot

Aturan intinya cuma satu: **token = sesi**. Login baru membunuh token lama,
tapi *memakai* token yang sama dari banyak device sekaligus aman. Terbukti —
satu token dipakai berurutan dengan User-Agent desktop, Android, dan bot:

```
desktop : 200
Android : 200
bot     : 200
sesudahnya: 200   (token tetap hidup)
```

Jadi jangan bikin sesi kedua. **Pakai token yang sama di HP dan di bot.**

## Alur yang disarankan (login di HP, bot ikut)

1. Di HP: buka `ebox.zone`, login OTP seperti biasa.
2. Ambil token di HP — jalankan bookmarklet di address bar (ketik manual,
   browser membuang `javascript:` kalau di-paste):

   ```js
   javascript:prompt('token',document.cookie.match(/(?:^|; )token=([^;]*)/)?.[1])
   ```

3. Di PC: nyalakan penampung token

   ```bash
   node ebox-token.mjs receive
   ```

   Terminal menampilkan dua URL: satu untuk PC, satu **untuk HP** (alamat LAN,
   HP harus di WiFi yang sama). URL-nya mengandung path acak, dan server
   menutup sendiri setelah 10 menit.

4. Di HP: buka URL LAN itu, tempel token, tekan **Simpan ke PC**. Token
   divalidasi dulu ke `/player/profile`; token sampah ditolak, jadi
   `.ebox-token` tidak pernah tertimpa sampah.

5. Selesai. HP tetap login (token itu juga yang dipakai bot), dan jadwal tiap
   jam lanjut tanpa SMS lagi.

Kalau browser HP menolak bookmarklet, alternatifnya: login di browser PC,
ambil token di sana (`bookmarklet` + `cookie`), dan jangan pakai HP untuk Ebox
— sesi HP memang tidak bisa diambil tanpa JS.

## Yang **tidak** boleh dilakukan

| Tindakan | Akibat |
|---|---|
| Login lagi di HP setelah bot punya token | Token bot mati → `sesi mati` sampai diganti |
| `node ebox-token.mjs otp ...` saat masih butuh sesi HP | Sesi HP ikut mati (token baru) |
| Menjalankan bot | **Aman** — bot tidak menerbitkan token baru |

## Perintah terkait

```bash
node ebox-token.mjs share              # URL javascript: untuk MEMASANG sesi ke device lain
node ebox-token.mjs receive            # port 8787, auto-tutup 10 menit
node ebox-token.mjs receive 8899 --stay   # port lain, jangan tutup setelah sukses
node ebox-token.mjs cookie "token=..."    # tempel manual di PC (tanpa server)
```
