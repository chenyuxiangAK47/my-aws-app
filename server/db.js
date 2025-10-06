// server/db.js
const Database = require('better-sqlite3');
const path = require('path');

// 数据库文件保存在项目目录下，重启也不会丢
const db = new Database(path.join(__dirname, 'app.db'));

// 初始化表（只建一次）
db.exec(`
  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    text TEXT NOT NULL,
    ip TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);

module.exports = {
  // 新增
  insertMessage(text, ip) {
    const stmt = db.prepare('INSERT INTO messages (text, ip) VALUES (?, ?)');
    const info = stmt.run(text, ip || null);
    return info.lastInsertRowid;
  },
  // 查询
  listMessages(limit = 50, offset = 0) {
    return db.prepare(
      `SELECT id, text, ip, created_at 
       FROM messages 
       ORDER BY id DESC LIMIT ? OFFSET ?`
    ).all(limit, offset);
  },
  // 删除
  deleteMessage(id) {
    return db.prepare('DELETE FROM messages WHERE id = ?').run(id).changes;
  },
};
