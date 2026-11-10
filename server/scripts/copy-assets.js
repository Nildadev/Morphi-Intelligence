/**
 * Copy the built-in skill Markdown into dist/. `tsc` only emits .js, so without this step a
 * packaged/Electron build would start with an empty skill catalogue and the in-app agent would
 * silently lose its working-agreement skills (the fake "no skills exist" state spec §6.6.2 forbids).
 */
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const source = path.join(root, 'src', 'harness', 'skills', 'builtin');
const target = path.join(root, 'dist', 'harness', 'skills', 'builtin');

if (!fs.existsSync(source)) {
  console.error(`[copy-assets] missing skill source: ${source}`);
  process.exit(1);
}

fs.mkdirSync(target, { recursive: true });
const files = fs.readdirSync(source).filter((file) => file.endsWith('.md')).sort();
for (const file of files) fs.copyFileSync(path.join(source, file), path.join(target, file));
console.log(`[copy-assets] ${files.length} built-in skill(s) -> ${path.relative(root, target)}`);
