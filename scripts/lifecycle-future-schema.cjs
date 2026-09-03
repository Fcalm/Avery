const fs = require('node:fs');
const { createRequire } = require('node:module');
const path = require('node:path');

function Run() {
  const resources = process.env.AVERY_INSTALLED_RESOURCES;
  const workspacePath = process.env.AVERY_LIFECYCLE_WORKSPACE;
  const resultPath = process.env.AVERY_LIFECYCLE_RESULT;
  if (![resources, workspacePath, resultPath].every(Boolean)) throw new Error('Future schema environment is incomplete.');
  // 从虚拟 asar 根解析 JS 依赖；Electron 会把 native .node 自动映射到 app.asar.unpacked。
  const appRequire = createRequire(path.join(resources, 'app.asar', 'package.json'));
  const Database = appRequire('better-sqlite3');
  const db = new Database(path.join(workspacePath, 'avery.db'));
  try {
    db.prepare("UPDATE workspace_meta SET schema_version = 7 WHERE id = 'workspace'").run();
    db.prepare('INSERT OR REPLACE INTO schema_migrations(version, checksum, applied_at) VALUES(7, ?, ?)').run('future-schema-checksum', Date.now());
  } finally { db.close(); }
  const result = { futureSchemaWritten: true };
  fs.writeFileSync(resultPath, JSON.stringify(result), 'utf8');
  console.log(JSON.stringify(result));
}

try { Run(); } catch (error) { console.error(error); process.exitCode = 1; }
