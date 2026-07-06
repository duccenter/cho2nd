require('dotenv').config();
const express = require('express');
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

console.log('Đang khởi động Telegram Bot...');

// Kích hoạt bot
bot.launch()
    .then(() => {
        console.log('Bot đã khởi động thành công!');
    })
    .catch((err) => {
        console.error('Lỗi khi khởi động bot:', err);
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
