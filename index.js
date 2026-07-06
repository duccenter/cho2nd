require('dotenv').config();
const express = require('express');
const cron = require('node-cron');
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
    // Kích hoạt bot
    bot.launch()
        .then(() => {
            console.log('Bot đã khởi động thành công!');
            
            // Thiết lập Cron Job chạy vào 8:00 sáng mỗi ngày theo giờ Việt Nam
            cron.schedule('0 8 * * *', () => {
                const chatId = process.env.GROUP_CHAT_ID;
                const topicId = process.env.MUABAN_TOPIC_ID;
                
                if (chatId && topicId) {
                    bot.telegram.sendMessage(
                        chatId, 
                        '🌅 **Chào buổi sáng cả nhà!**\n\nHôm nay bạn có món hàng gì cần bán không? Đừng quên đăng vào nhóm kèm hashtag #ban hoặc #mua nhé! Chúc mọi người một ngày buôn may bán đắt! 💰', 
                        { 
                            message_thread_id: parseInt(topicId),
                            parse_mode: 'Markdown'
                        }
                    ).then(() => {
                        console.log('Đã gửi tin nhắn nhắc nhở buổi sáng thành công.');
                    }).catch(err => {
                        console.error('Lỗi khi gửi tin nhắn buổi sáng:', err);
                    });
                } else {
                    console.log('Chưa cấu hình GROUP_CHAT_ID hoặc MUABAN_TOPIC_ID nên không thể gửi tin nhắn.');
                }
            }, {
                scheduled: true,
                timezone: "Asia/Ho_Chi_Minh"
            });
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
