import { access, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const requiredFiles = ['index.html', 'app.mjs', 'domna-logo.png', 'vercel.json'];

async function main() {
  for (const file of requiredFiles) {
    await access(path.join(root, file));
  }

  const html = await readFile(path.join(root, 'index.html'), 'utf8');
  const app = await readFile(path.join(root, 'app.mjs'), 'utf8');

  const checks = [
    ['single PDF input present', html.includes('id="sourcePdf"')],
    ['D1 Ventilation title present', html.includes('D1 Ventilation')],
    ['version 1.1.1 visible', html.includes('v1.1.1')],
    ['app imported from index with cache busting', html.includes('src="./app.mjs?v=1.1.1"')],
    ['single report extraction function present', app.includes('extractReport(pdf)')],
    ['Domna PDF filename present', app.includes("downloadBlob(blob, 'D1-Ventilation.pdf')")]
  ];

  const failures = checks.filter(([, passed]) => !passed);

  if (failures.length) {
    failures.forEach(([label]) => {
      console.error(`FAIL: ${label}`);
    });
    process.exit(1);
  }

  checks.forEach(([label]) => {
    console.log(`PASS: ${label}`);
  });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
