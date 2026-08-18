/** 存量库在 v4 前缺少 revision 列，按表补列；新库已在 v1 建表声明，PRAGMA 检查避免重复添加。 */
module.exports = {
  up(db) {
    for (const table of ['conversations', 'jobs', 'applications']) {
      const columns = db.prepare(`PRAGMA table_info(${table})`).all();
      if (!columns.some((column) => column.name === 'revision')) {
        db.exec(`ALTER TABLE ${table} ADD COLUMN revision INTEGER NOT NULL DEFAULT 1`);
      }
    }
  },
};
