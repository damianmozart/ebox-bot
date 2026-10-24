#!/usr/bin/env node
/*
 * ntfy-echo.mjs — server ntfy tiruan untuk MELIHAT isi notifikasi persis
 * seperti yang akan diterima di HP, tanpa benar-benar mengirim apa pun.
 *
 * Pakai (dua terminal):
 *   node tools/ntfy-echo.mjs 8899
 *   EBOX_NTFY_URL=http://127.0.0.1:8899/ EBOX_NTFY_TOPIC=uji \
 *     node ebox-daily.mjs --notify-all
 *
 * Isi pesan terakhir dicetak ke terminal ini.
 */
import { createServer } from 'node:http';

const port = Number(process.argv[2] || 8899);

createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const raw = Buffer.concat(chunks).toString();
    let msg = null;
    try { msg = JSON.parse(raw); } catch { /* bukan JSON */ }
    console.log('─'.repeat(60));
    if (msg) {
      console.log(`title   : ${msg.title}`);
      console.log(`topic   : ${msg.topic}`);
      console.log(`message :\n${msg.message}`);
    } else {
      console.log(raw);
    }
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('ok');
  });
}).listen(port, '127.0.0.1', () => {
  console.error(`ntfy tiruan siap di http://127.0.0.1:${port}/ (Ctrl+C untuk stop)`);
});
