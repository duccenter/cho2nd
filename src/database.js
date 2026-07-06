const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');

// Ensure data directory exists
const dataDir = path.join(__dirname, '../data');
if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir);
}

const dbPath = path.join(dataDir, 'database.sqlite');
const db = new sqlite3.Database(dbPath, (err) => {
    if (err) {
        console.error('Lỗi khi kết nối với SQLite database:', err.message);
    } else {
        console.log('Đã kết nối với SQLite database.');
        initDb();
    }
});

function initDb() {
    db.serialize(() => {
        // Tạo bảng lưu trữ thông tin người dùng
        db.run(`
            CREATE TABLE IF NOT EXISTS users (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                telegram_id TEXT UNIQUE NOT NULL,
                username TEXT,
                first_name TEXT,
                last_name TEXT,
                joined_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )
        `);

        // Tạo bảng lưu trữ các bài đăng bán hàng
        db.run(`
            CREATE TABLE IF NOT EXISTS posts (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                message_id INTEGER NOT NULL,
                user_id INTEGER NOT NULL,
                content TEXT,
                status TEXT DEFAULT 'pending', -- pending, approved, rejected
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (user_id) REFERENCES users (telegram_id)
            )
        `);
    });
}

module.exports = db;
