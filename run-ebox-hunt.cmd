@echo off
rem Jalankan HANYA langkah Treasure Hunt (free hunt) sekali.
rem Dipanggil Task Scheduler tiap menit di sekitar jam buka: sesi V2 (Level 2+)
rem buka 12:00 WIB dan diundi 12:10 WIB, jadi jendelanya cuma 10 menit —
rem jadwal per jam (menit :53) tidak akan pernah kena.
cd /d "C:\home\user\ebox-bot"
"C:\Program Files\nodejs\node.exe" ebox-daily.mjs --hunt-only >> ebox-daily.out.log 2>&1
