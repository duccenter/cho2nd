require('dotenv').config();
const express = require('express');
const cron = require('node-cron');
const db = require('./src/database');
const bot = require('./src/bot');
const news = require('./src/news');

const app = express();
const PORT = process.env.PORT || 3000;

// Dummy route để Render có thể ping kiểm tra web service
app.get('/', (req, res) => {
    res.send('Telegram Bot is running!');
});

// Cấu hình API để kích hoạt thủ công Bản Tin (Ping bằng cron-job.org nếu Render ngủ đông)
app.get('/cron/news', async (req, res) => {
    const chatId = process.env.GROUP_CHAT_ID;
    const topicId = 9; // Topic "Thảo luận và hỏi đáp"
    
    if (!chatId) return res.status(500).send('Chưa cấu hình GROUP_CHAT_ID.');

    try {
        const message = await news.getDailyNewsMessage();
        if (message) {
            await bot.telegram.sendMessage(chatId, message, {
                message_thread_id: topicId,
                parse_mode: 'Markdown',
                disable_web_page_preview: false
            });
            res.send('Đã gửi bản tin thành công!');
        } else {
            res.send('Không có tin tức mới trong 24h qua.');
        }
    } catch (err) {
        console.error('Lỗi khi gửi bản tin:', err);
        res.status(500).send('Lỗi máy chủ.');
    }
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
            
            // Thiết lập Cron Job chạy lúc 10:00 sáng mỗi ngày
            cron.schedule('0 10 * * *', async () => {
                const chatId = process.env.GROUP_CHAT_ID;
                const topicId = 9;
                
                if (chatId) {
                    try {
                        const message = await news.getDailyNewsMessage();
                        if (message) {
                            await bot.telegram.sendMessage(chatId, message, {
                                message_thread_id: topicId,
                                parse_mode: 'Markdown',
                                disable_web_page_preview: false
                            });
                            console.log('Đã gửi Bản tin 10h sáng thành công.');
                        }
                    } catch (err) {
                        console.error('Lỗi gửi Bản tin bằng Cron:', err);
                    }
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
