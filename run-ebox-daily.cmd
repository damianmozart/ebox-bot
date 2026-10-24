@echo off
rem Jalankan klaim harian Ebox sekali (dipanggil Task Scheduler tiap jam).
rem Bot ini idempoten: kalau sudah diklaim, run berikutnya cuma melapor.
cd /d "C:\home\user\ebox-bot"
"C:\Program Files\nodejs\node.exe" ebox-daily.mjs >> ebox-daily.out.log 2>&1
