require('dotenv').config();
const express = require('express');
const db = require('./src/database');
const bot = require('./src/bot');

const app = express();
const PORT = process.env.PORT || 3000;

// Dummy route để Render có thể ping kiểm tra web service
app.get('/', (req, res) => {
    res.send('Telegram Bot is running!');
});

// Khởi động Express server (Bắt buộc với Render Web Service)
app.listen(PORT, () => {
    console.log(`Web server đang chạy trên port ${PORT}`);
});

console.log('Đang kết nối CSDL và khởi động Telegram Bot...');

// Kết nối CSDL trước khi kích hoạt Bot
db.connectDB().then(() => {
    // Kích hoạt bot với allowedUpdates để nhận sự kiện chat_member
    bot.launch({
        allowedUpdates: ['message', 'callback_query', 'chat_member']
    })
        .then(() => {
            console.log('Bot đã khởi động thành công!');
        })
        .catch((err) => {
            console.error('Lỗi khi khởi động bot:', err);
        });
});

// Xử lý các tín hiệu tắt để dừng bot an toàn
process.once('SIGINT', () => {
    bot.stop('SIGINT');
    process.exit(0);
});
process.once('SIGTERM', () => {
    bot.stop('SIGTERM');
    process.exit(0);
});
