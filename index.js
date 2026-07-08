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

// Cấu hình API để Kích hoạt Lời chào từ bên ngoài (Giải pháp cho máy chủ ngủ đông)
app.get('/cron/morning', (req, res) => {
    const chatId = process.env.GROUP_CHAT_ID;
    const topicIdsStr = process.env.MUABAN_TOPIC_IDS || process.env.MUABAN_TOPIC_ID;
    
    if (!chatId || !topicIdsStr) {
        return res.status(500).send('Chưa cấu hình GROUP_CHAT_ID hoặc MUABAN_TOPIC_IDS.');
    }

    const topicIds = topicIdsStr.split(',').map(id => id.trim());
    let successCount = 0;

    topicIds.forEach(tId => {
        if (!tId) return;
        bot.telegram.sendMessage(
            chatId, 
            '🌅 **Chào buổi sáng cả nhà!**\n\nHôm nay bạn có món hàng gì cần bán không? Hãy đăng ngay vào nhóm nhé! (Lưu ý: Bắt buộc đính kèm Hình Ảnh thực tế, Giá Tiền và Số Điện Thoại). Chúc mọi người một ngày buôn may bán đắt! 💰', 
            { 
                message_thread_id: parseInt(tId),
                parse_mode: 'Markdown'
            }
        ).then(() => {
            console.log(`Đã gửi tin nhắn buổi sáng tới Topic ${tId}`);
            successCount++;
        }).catch(err => {
            console.error(`Lỗi khi gửi tới Topic ${tId}:`, err);
        });
    });

    res.send(`Đã kích hoạt kịch bản chào buổi sáng. Yêu cầu gửi tới ${topicIds.length} phòng.`);
});

console.log('Đang kết nối CSDL và khởi động Telegram Bot...');

// Kết nối CSDL trước khi kích hoạt Bot
db.connectDB().then(() => {
    // Kích hoạt bot
    bot.launch()
        .then(() => {
            console.log('Bot đã khởi động thành công!');
            
            // Thiết lập Cron Job chạy vào 8:00 sáng mỗi ngày theo giờ Việt Nam
            // (Chỉ hoạt động nếu máy chủ không bị ngủ đông)
            cron.schedule('0 8 * * *', () => {
                const chatId = process.env.GROUP_CHAT_ID;
                const topicIdsStr = process.env.MUABAN_TOPIC_IDS || process.env.MUABAN_TOPIC_ID;
                
                if (chatId && topicIdsStr) {
                    const topicIds = topicIdsStr.split(',').map(id => id.trim());
                    
                    for (const tId of topicIds) {
                        if (!tId) continue;
                        bot.telegram.sendMessage(
                            chatId, 
                            '🌅 **Chào buổi sáng cả nhà!**\n\nHôm nay bạn có món hàng gì cần bán không? Hãy đăng ngay vào nhóm nhé! (Lưu ý: Bắt buộc đính kèm Hình Ảnh thực tế, Giá Tiền và Số Điện Thoại). Chúc mọi người một ngày buôn may bán đắt! 💰', 
                            { 
                                message_thread_id: parseInt(tId),
                                parse_mode: 'Markdown'
                            }
                        ).then(() => {
                            console.log(`Đã gửi tin nhắn nhắc nhở buổi sáng tới Topic ${tId} thành công.`);
                        }).catch(err => {
                            console.error(`Lỗi khi gửi tin nhắn buổi sáng tới Topic ${tId}:`, err);
                        });
                    }
                } else {
                    console.log('Chưa cấu hình GROUP_CHAT_ID hoặc MUABAN_TOPIC_IDS nên không thể gửi tin nhắn.');
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
