// Sends a status built from the test fixture to a running Worker, the same way the Apps Script will.
//   node scripts/post-status.js [--at 2026-10-07T20:12:00Z] [--url http://localhost:8787]
// Uses UPDATE_SECRET from .dev.vars. For local development only.
const fs = require('node:fs');
const core = require('../apps-script/src/core.js');
const fixture = require('../test/fixtures/fall-2026.json');

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : fallback;
};
const url = arg('url', 'http://localhost:8787');
const at = arg('at', new Date().toISOString());
const secret = /^UPDATE_SECRET=(.*)$/m.exec(fs.readFileSync('.dev.vars', 'utf8'))[1].trim();

const status = core.buildStatus({ ...fixture, now: at });
fetch(`${url}/api/update`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json' },
  body: JSON.stringify(status),
}).then(async (res) => {
  console.log(`${res.status} ${await res.text()}`);
  console.log(`status as of ${status.updated}: ${status.today.city}${status.today.transit ? ' (travel day)' : ''}, ${status.trips.length} trips`);
  process.exitCode = res.ok ? 0 : 1;
});
