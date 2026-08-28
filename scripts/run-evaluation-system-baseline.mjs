import { spawn } from 'node:child_process';
import electron from 'electron';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const child = spawn(electron, [join(projectRoot, 'scripts', 'evaluation-system-baseline.mjs')], {
  cwd: projectRoot,
  env: process.env,
  stdio: ['ignore', 'pipe', 'pipe'],
  windowsHide: true,
});

let stdout = '';
child.stdout.on('data', (chunk) => {
  const text = chunk.toString();
  stdout += text;
  process.stdout.write(text);
});
child.stderr.on('data', (chunk) => process.stderr.write(chunk));
child.on('error', (error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
child.on('close', (code) => {
  // Electron 在部分 Windows 环境会把 app 退出码归一为 0，因此同时要求成功收据。
  process.exitCode = code === 0 && /"success":true/.test(stdout) ? 0 : 1;
});
