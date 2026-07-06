const { Telegraf } = require('telegraf');
const db = require('./database');

if (!process.env.BOT_TOKEN) {
    console.error('Lỗi: BOT_TOKEN không được tìm thấy trong biến môi trường.');
    process.exit(1);
}

const bot = new Telegraf(process.env.BOT_TOKEN);

// Middleware để lưu/cập nhật thông tin người dùng
bot.use(async (ctx, next) => {
    if (ctx.from) {
        const { id, username, first_name, last_name } = ctx.from;
        db.run(
            `INSERT INTO users (telegram_id, username, first_name, last_name) 
             VALUES (?, ?, ?, ?)
             ON CONFLICT(telegram_id) DO UPDATE SET 
             username=excluded.username, 
             first_name=excluded.first_name, 
             last_name=excluded.last_name`,
            [id, username, first_name, last_name]
        );
    }
    return next();
});

// Chào mừng thành viên mới
bot.on('new_chat_members', (ctx) => {
    const newMembers = ctx.message.new_chat_members;
    for (const member of newMembers) {
        const name = member.first_name || member.username || 'Thành viên mới';
        ctx.reply(`Chào mừng ${name} đã tham gia nhóm bán hàng 2nd! 🎉\nVui lòng đọc quy định nhóm bằng lệnh /rules trước khi đăng bài nhé.`);
    }
});

// Lệnh /start
bot.start((ctx) => {
    ctx.reply('Xin chào! Tôi là Bot quản lý nhóm bán hàng 2nd. Dùng /help để xem các chức năng.');
});

// Lệnh /help
bot.help((ctx) => {
    ctx.reply(
        'Danh sách lệnh:\n' +
        '/start - Bắt đầu với bot\n' +
        '/help - Xem trợ giúp\n' +
        '/rules - Xem quy định đăng bài'
    );
});

// Lệnh /rules
bot.command('rules', (ctx) => {
    ctx.reply(
        '📜 **Quy định đăng bài:**\n' +
        '1. Mọi bài viết bán hoặc mua đều phải chứa hashtag #ban hoặc #mua.\n' +
        '2. Bài viết phải ghi rõ giá cả (ví dụ: Giá: 100k) và tình trạng sản phẩm.\n' +
        '3. Không spam, không đăng sản phẩm cấm.\n' +
        'Các bài đăng sai quy định sẽ bị tự động xóa.'
    , { parse_mode: 'Markdown' });
});

// Lệnh /gettopicid để lấy ID của topic và ID của Group
bot.command('gettopicid', (ctx) => {
    if (ctx.message.is_topic_message && ctx.message.message_thread_id) {
        ctx.reply(`📌 **Thông số để cài đặt trên Render:**\n\n1. Biến **MUABAN_TOPIC_ID** có giá trị là: \`${ctx.message.message_thread_id}\`\n2. Biến **GROUP_CHAT_ID** có giá trị là: \`${ctx.chat.id}\`\n\nHãy vào Render thêm biến thứ 2 (GROUP_CHAT_ID) để bot có thể tự động gửi tin nhắn 8h sáng hàng ngày nhé!`, { parse_mode: 'Markdown' });
    } else {
        ctx.reply('Lệnh này chỉ dùng được bên trong một Topic (Chủ đề) của nhóm Diễn đàn (Forum).');
    }
});

// Danh sách các từ khóa thô tục (Blacklist)
const BAD_WORDS = ['đm', 'vcl', 'địt', 'lồn', 'cặc', 'phò', 'đĩ', 'chó đẻ'];

// Xử lý và kiểm duyệt tin nhắn trong nhóm
bot.on('text', async (ctx) => {
    const msg = ctx.message;
    const text = msg.text.toLowerCase();
    
    // Nếu tin nhắn là lệnh thì bỏ qua
    if (text.startsWith('/')) return;

    // Kiểm duyệt bài viết trong nhóm (bỏ qua tin nhắn riêng cho bot)
    if (ctx.chat.type === 'group' || ctx.chat.type === 'supergroup') {
        
        // 1. KIỂM TRA TỪ NGỮ THÔ TỤC (Áp dụng cho mọi Topic)
        const hasBadWord = BAD_WORDS.some(word => new RegExp(`\\b${word}\\b`, 'i').test(text));
        
        if (hasBadWord) {
            try {
                // Xóa tin nhắn thô tục
                await ctx.deleteMessage(msg.message_id).catch(() => {});
                
                // Khóa chat 1 ngày (86400 giây)
                const untilDate = Math.floor(Date.now() / 1000) + 86400;
                await ctx.telegram.restrictChatMember(ctx.chat.id, msg.from.id, {
                    permissions: { can_send_messages: false },
                    until_date: untilDate
                });
                
                // Thông báo công khai
                await ctx.reply(`🚫 Người dùng @${msg.from.username || msg.from.first_name} đã bị khóa chat 1 ngày do sử dụng ngôn từ thô tục.`);
            } catch (err) {
                console.error('Không thể xử lý vi phạm thô tục (có thể do thiếu quyền Admin):', err);
            }
            return; // Dừng xử lý tiếp
        }

        // 2. KIỂM TRA ĐỊNH DẠNG MUA BÁN
        const isTopic = msg.is_topic_message;
        const topicId = msg.message_thread_id;
        const muabanTopicId = process.env.MUABAN_TOPIC_ID ? parseInt(process.env.MUABAN_TOPIC_ID) : null;

        // Xác định xem có cần cảnh báo định dạng tin nhắn này không
        let shouldModerate = false;
        
        if (!muabanTopicId) {
            shouldModerate = true; // Chưa cài đặt Topic thì áp dụng tất cả
        } else if (isTopic && topicId === muabanTopicId) {
            shouldModerate = true; // Chỉ áp dụng ở Topic Mua Bán
        }

        if (shouldModerate) {
            const hasTag = text.includes('#ban') || text.includes('#mua');
            
            if (!hasTag) {
                // Cảnh báo sai định dạng (NHƯNG KHÔNG XÓA BÀI)
                try {
                    const warning = await ctx.reply(`@${msg.from.username || msg.from.first_name}, bài viết của bạn có vẻ sai định dạng (thiếu hashtag #ban hoặc #mua). Vui lòng đọc /rules để sửa lại nhé!`);
                    
                    // Tự động xóa cảnh báo sau 15 giây để đỡ rác nhóm
                    setTimeout(() => {
                        ctx.telegram.deleteMessage(ctx.chat.id, warning.message_id).catch(() => {});
                    }, 15000);
                } catch (err) {
                    console.error('Không thể gửi cảnh báo:', err);
                }
            } else {
                // Lưu bài viết hợp lệ vào database
                db.run(
                    `INSERT INTO posts (message_id, user_id, content, status) VALUES (?, ?, ?, ?)`,
                    [msg.message_id, msg.from.id, msg.text, 'approved']
                );
            }
        }
    }
});

// Bắt lỗi chung để bot không bị crash
bot.catch((err, ctx) => {
    console.error(`Có lỗi xảy ra cho update ${ctx.updateType}`, err);
});

module.exports = bot;
