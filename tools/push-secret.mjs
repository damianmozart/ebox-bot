#!/usr/bin/env node
/*
 * push-secret.mjs — dorong token + ntfyTopic ke GitHub Secret `EBOX_CONFIG`.
 *
 * Kenapa perlu: repo ini publik (supaya menit Actions tak terbatas), jadi token
 * TIDAK boleh di-commit. Workflow menulis config.json dari Secret ini saat job
 * berjalan. Setiap kali token mati / diganti, jalankan skrip ini lagi supaya
 * cloud memakai token yang sama dengan laptop.
 *
 * Pakai:
 *   cd tools && npm install      # sekali saja (libsodium untuk enkripsi secret)
 *   node push-secret.mjs         # baca ../config.json + ../.ebox-token, lalu kirim
 *   node push-secret.mjs --dry   # cuma tampilkan ringkasan (token disamarkan)
 *
 * Token GitHub diambil dari env GH_TOKEN / GITHUB_TOKEN, atau otomatis dari
 * Git Credential Manager (`git credential fill`). Repo diambil dari remote
 * `origin`.
 */
import { execSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const sodium = createRequire(import.meta.url)('libsodium-wrappers');
const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const SECRET_NAME = 'EBOX_CONFIG';
const DRY = process.argv.includes('--dry');

function ghToken() {
  if (process.env.GH_TOKEN) return process.env.GH_TOKEN.trim();
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN.trim();
  try {
    const out = execSync('git credential fill', {
      cwd: ROOT,
      input: 'protocol=https\nhost=github.com\n\n',
      encoding: 'utf8',
    });
    const line = out.split('\n').find((l) => l.startsWith('password='));
    if (line) return line.slice('password='.length).trim();
  } catch { /* jatuh ke error di bawah */ }
  throw new Error('Token GitHub tidak ditemukan. Set GH_TOKEN lalu jalankan ulang.');
}

function repoSlug() {
  const url = execSync('git remote get-url origin', { cwd: ROOT, encoding: 'utf8' }).trim();
  const m = url.match(/github\.com[/:]([^/]+)\/([^/.]+)(?:\.git)?$/);
  if (!m) throw new Error(`Tidak bisa membaca repo dari remote: ${url}`);
  return `${m[1]}/${m[2]}`;
}

function buildConfig() {
  const cfgPath = resolve(ROOT, 'config.json');
  const tokPath = resolve(ROOT, '.ebox-token');
  const cfg = existsSync(cfgPath) ? JSON.parse(readFileSync(cfgPath, 'utf8')) : {};
  const token = existsSync(tokPath) ? readFileSync(tokPath, 'utf8').trim() : '';
  if (!token) throw new Error('.ebox-token kosong — jalankan `node ebox-token.mjs otp <nomor>` dulu.');
  // Bentuk yang dibaca ebox-daily.mjs: accounts[0].token, lalu ntfyTopic.
  return {
    accounts: [{ name: 'utama', token }],
    ntfyTopic: cfg.ntfyTopic || '',
  };
}

async function main() {
  const slug = repoSlug();
  const token = ghToken();
  const config = buildConfig();
  const masked = { ...config, accounts: config.accounts.map((a) => ({ ...a, token: `<${String(a.token).length} karakter>` })) };

  if (DRY) {
    console.log(`dry-run → ${slug} (secret ${SECRET_NAME})`);
    console.log(JSON.stringify(masked, null, 2));
    return;
  }

  await sodium.ready;
  const { key_id, key } = await fetch(`https://api.github.com/repos/${slug}/actions/secrets/public-key`, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' },
  }).then((r) => r.json());

  const message = JSON.stringify(config);
  const sealed = sodium.to_base64(
    sodium.crypto_box_seal(message, sodium.from_base64(key, sodium.base64_variants.ORIGINAL)),
    sodium.base64_variants.ORIGINAL,
  );

  const res = await fetch(`https://api.github.com/repos/${slug}/actions/secrets/${SECRET_NAME}`, {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ encrypted_value: sealed, key_id }),
  });

  if (res.status !== 201 && res.status !== 204) {
    throw new Error(`Gagal menulis secret: HTTP ${res.status} ${await res.text()}`);
  }
  console.log(`✓ ${SECRET_NAME} diperbarui di ${slug} (token ${String(config.accounts[0].token).length} karakter)`);
}

main().catch((e) => {
  console.error(`✗ ${e?.message || e}`);
  process.exitCode = 1;
});
