// npm postinstall: on Render (or with INSTALL_CURL_TRANSPORT=1) create .venv with curl_cffi, the browser-compatible
// HTTPS client DraftKings' snapshot host accepts from cloud IPs (see src/transport/http.js).
// Never fails the install: without it the server still runs, and DraftKings snapshots come from the edge instead.
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
if (process.env.RENDER === 'true' || process.env.INSTALL_CURL_TRANSPORT === '1') {
  const py = `${root}.venv/bin/python`;
  try {
    if (!existsSync(py)) execFileSync(process.env.PYTHON_BOOTSTRAP || 'python3', ['-m', 'venv', '.venv'], { cwd: root, stdio: 'inherit', timeout: 120_000 });
    execFileSync(py, ['-m', 'pip', 'install', '--quiet', '--disable-pip-version-check', '-r', 'requirements.txt'], { cwd: root, stdio: 'inherit', timeout: 300_000 });
    execFileSync(py, ['-c', 'import curl_cffi; print("browser-compatible client ready: curl_cffi", curl_cffi.__version__)'], { cwd: root, stdio: 'inherit' });
  } catch (e) {
    console.warn(`[install-transport] skipped (${e.message.split('\n')[0]}); DraftKings snapshots will need the edge`);
  }
}
