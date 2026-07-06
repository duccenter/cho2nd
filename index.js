require('dotenv').config();
const bot = require('./src/bot');

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
