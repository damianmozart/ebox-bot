@echo off
rem Pasang (atau timpa) dua jadwal Ebox:
rem   1. "Ebox Daily"  — tiap jam, klaim free draw / poin / box harian
rem   2. "Ebox Hunt"   — tiap menit 11:58-12:13 WIB, Treasure Hunt (jendela
rem                      10 menit: buka 12:00, diundi 12:10)
rem Jalankan sekali dari Command Prompt: install-schedule.cmd
rem Hapus: schtasks /Delete /TN "Ebox Daily" /F  &  schtasks /Delete /TN "Ebox Hunt" /F
setlocal
set DAILY=Ebox Daily
set HUNT=Ebox Hunt
set DIR=C:\home\user\ebox-bot

schtasks /Create /SC HOURLY /TN "%DAILY%" /TR "%DIR%\run-ebox-daily.cmd" /F
if errorlevel 1 (
  echo GAGAL memasang jadwal harian.
  exit /b 1
)

schtasks /Create /SC DAILY /TN "%HUNT%" /TR "%DIR%\run-ebox-hunt.cmd" /ST 11:58 /RI 1 /DU 00:15 /F
if errorlevel 1 (
  echo GAGAL memasang jadwal Treasure Hunt.
  exit /b 1
)

rem Jendela Treasure Hunt cuma 10 menit, jadi task ini TIDAK boleh dilewati
rem hanya karena laptop sedang memakai baterai.
powershell -NoProfile -Command "$t=Get-ScheduledTask -TaskName 'Ebox Hunt'; $t.Settings.DisallowStartIfOnBatteries=$false; $t.Settings.StopIfGoingOnBatteries=$false; Set-ScheduledTask -TaskName 'Ebox Hunt' -Settings $t.Settings | Out-Null"

echo.
for %%T in ("%DAILY%" "%HUNT%") do (
  schtasks /Query /TN %%T /FO LIST | findstr /R /C:"TaskName" /C:"Status" /C:"Next Run Time" /C:"Task To Run"
)
