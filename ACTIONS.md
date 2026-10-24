# Bot di GitHub Actions — laptop boleh dimatikan 🐙

Bot jalan sebagai workflow GitHub, bukan di laptop. Dua workflow:

| Workflow | Kapan | Yang dikerjakan |
|---|---|---|
| `ebox-daily` | cron tiap jam (menit :07) | free draw, poin harian, box harian |
| `ebox-hunt` | dipanggil **tiap menit** | Treasure Hunt: tunggu detik buka, lalu join |

## Kenapa tidak sekadar "cron jam 12:00"

Jendela Treasure Hunt cuma **10 menit** (buka 12:00 WIB, diundi 12:10 WIB),
dan cron GitHub sering telat puluhan detik sampai beberapa menit — kadang
didiamkan sama sekali saat antrean repo sedang padat. Jadi `ebox-hunt` tidak
menembak sekali lalu menyerah:

1. dipanggil tiap menit (pemicu utama: cron-job.org, lihat bawah),
2. kalau sesi berikutnya **masih >90 detik** lagi → job langsung keluar (murah),
3. kalau **≤90 detik** → job tidur memakai **jam server** (bukan jam runner
   yang bisa meleset) sampai detik buka, tembak join,
4. kalau server masih menjawab `has not opened yet`, ulangi tiap **2,5 detik**
   sampai 100 detik.

Hasilnya: telat 1–2 menit pun tetap ikut, karena job-nya *menunggu*, bukan
menembak sekali di detik yang salah.

## Rahasia tidak pernah masuk repo

Repo ini **publik** (supaya menit Actions tak terbatas — repo privat cuma
2.000 menit/bulan dan pola "tunggu tiap menit" akan cepat menghabiskannya).
Token akun **tidak** ikut ter-commit: `.ebox-token` dan `config.json` ada di
`.gitignore`, dan workflow menulis `config.json` dari **Secret** `EBOX_CONFIG`
saat job berjalan.

## Setup sekali

1. **Secret `EBOX_CONFIG`** — isinya token + topik ntfy. Jangan ketik manual,
   dorong dari laptop:

   ```bash
   cd tools && npm install     # sekali saja (libsodium untuk enkripsi)
   node push-secret.mjs        # baca ../config.json + ../.ebox-token
   node push-secret.mjs --dry  # cek isinya dulu (token disamarkan)
   ```

2. **Pemicu tiap menit (cron-job.org)** — gratis, tanpa kartu:

   1. Buat Personal Access Token (classic) di GitHub:
      *Settings → Developer settings → Personal access tokens → Generate new
      token (classic)* → scope **repo** → salin.
   2. Daftar di **cron-job.org** → **Create cronjob**:
      - Title: `ebox hunt`
      - URL: `https://api.github.com/repos/damianmozart/ebox-bot/dispatches`
      - Schedule: **every 1 minute**
      - Request method: **POST**
      - Header `Authorization`: `Bearer <PAT tadi>`
      - Header `Content-Type`: `application/json`
      - Header `Accept`: `application/vnd.github+json`
      - Body: `{"event_type":"tick"}`
   3. Simpan, buka **History** — harus `HTTP 204`. Kalau `401`, PAT salah;
      `404`, nama repo/owner salah.

3. **Tes manual** — tab *Actions* → `ebox-hunt` → **Run workflow**.
   Di luar jendela 12:00 hasilnya `⏳ hunt: buka 12.00 — belum masuk jendela`
   (itu benar: job sengaja tidak menunggu berjam-jam).

## Kalau token mati

Login baru di HP/browser **mematikan** token lama, jadi cloud ikut mati. Pulihkan:

```bash
node ebox-token.mjs receive       # atau otp <nomor> --code <kode>
cd tools && node push-secret.mjs  # dorong token baru ke Secret
```

Sampai Secret diperbarui, `ebox-daily` akan lapor `🔑 sesi mati` ke ntfy
(maksimal sekali per 6 jam).

## Batas yang jujur

- **Runner GitHub ada di US/EU**, jadi RTT ke server Jakarta ±200–400 ms lebih
  lambat dari laptop. Untuk kuota yang habis dalam hitungan detik, laptop
  (atau VPS Singapura) masih lebih cepat. 270 slot V2 biasanya tidak seketat itu.
- **Jam runner bisa meleset**, makanya perhitungan pakai `current_time_ms` dari
  server Ebox, bukan jam lokal runner.
- **cron-job.org/bawaan GitHub bisa mati** — kalau repo ini tidak dipanggil
  sama sekali, tidak ada yang join. Cek tab *Actions* kalau notif tidak masuk.
- **Menjalankan laptop + cloud bersamaan aman**: join/klaim idempoten, dan yang
  sudah dikerjakan tidak dinotifikasi dua kali.
