import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

const dir = path.join('.cache', 'ebox');
const files = readdirSync(dir).filter(f => f.endsWith('.js'));
const endpoints = new Set();
for (const f of files) {
  const content = readFileSync(path.join(dir, f), 'utf8');
  const matches = content.match(/['"]\/(?:player|product|goods|home|order|box|public|winner|leaderboard)[a-zA-Z0-9_\-\/]*['"]/g) || [];
  for (const m of matches) {
    endpoints.add(m.replace(/['"]/g, ''));
  }
}
console.log(JSON.stringify([...endpoints].sort(), null, 2));
