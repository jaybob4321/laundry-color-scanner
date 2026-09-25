#!/usr/bin/env node
/**
 * Build numeric reference profiles from curated photos (blueprint §14).
 *
 *   node scripts/build-reference-profiles.mjs <manifest.json>
 *        [--out data/reference-profiles.json] [--report reference-report.json]
 *
 * Outputs pending profiles (a curator approves them by setting
 * "status": "approved" after checking the crop and color) and a report of
 * accepted, patterned and rejected records. Photos are never copied.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { buildReferenceProfiles, loadManifest } from './lib/reference-builder.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const args = process.argv.slice(2);
const options = {};
const positional = [];
for (let i = 0; i < args.length; i++) {
  if (args[i].startsWith('--')) options[args[i]] = args[++i];
  else positional.push(args[i]);
}
const opt = (name, fallback) => options[name] ?? fallback;
const [manifestPath] = positional;
if (!manifestPath) {
  console.error('Usage: node scripts/build-reference-profiles.mjs <manifest.json> [--out file] [--report file]');
  process.exit(2);
}
const outPath = opt('--out', `${root}data/reference-profiles.json`);
const reportPath = opt('--report', 'reference-report.json');
const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));

const { manifest, manifestDir } = loadManifest(manifestPath);
const { profileSet, report } = buildReferenceProfiles({
  manifest,
  manifestDir,
  config: readJson(`${root}data/detector-config.json`),
  palette: readJson(`${root}data/colors.json`),
  existing: existsSync(outPath) ? readJson(outPath) : { profiles: [] },
});
writeFileSync(outPath, `${JSON.stringify(profileSet, null, 2)}\n`);
writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
console.log(`profiles: ${report.accepted.length} accepted (pending review), ${report.patterns.length} patterned, ${report.rejected.length} rejected`);
for (const r of report.rejected) console.log(`  rejected ${r.id ?? '?'}: ${r.reason}`);
console.log(`wrote ${outPath} and ${reportPath}. Run \`npm run build\` afterwards to refresh the offline cache.`);
