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

// Xử lý và kiểm duyệt tin nhắn trong nhóm
bot.on('text', async (ctx) => {
    const msg = ctx.message;
    const text = msg.text.toLowerCase();
    
    // Nếu tin nhắn là lệnh thì bỏ qua
    if (text.startsWith('/')) return;

    // Kiểm duyệt bài viết trong nhóm (bỏ qua tin nhắn riêng cho bot)
    if (ctx.chat.type === 'group' || ctx.chat.type === 'supergroup') {
        const hasTag = text.includes('#ban') || text.includes('#mua');
        
        if (!hasTag) {
            // Xóa tin nhắn nếu không có tag hợp lệ
            try {
                await ctx.deleteMessage(msg.message_id);
                const warning = await ctx.reply(`@${msg.from.username || msg.from.first_name}, bài viết của bạn đã bị xóa vì không chứa hashtag #ban hoặc #mua. Vui lòng đọc /rules.`);
                // Tự động xóa cảnh báo sau 10 giây
                setTimeout(() => {
                    ctx.telegram.deleteMessage(ctx.chat.id, warning.message_id).catch(() => {});
                }, 10000);
            } catch (err) {
                console.error('Không có quyền xóa tin nhắn:', err);
            }
        } else {
            // Lưu bài viết hợp lệ vào database
            db.run(
                `INSERT INTO posts (message_id, user_id, content, status) VALUES (?, ?, ?, ?)`,
                [msg.message_id, msg.from.id, msg.text, 'approved']
            );
        }
    }
});

// Bắt lỗi chung để bot không bị crash
bot.catch((err, ctx) => {
    console.error(`Có lỗi xảy ra cho update ${ctx.updateType}`, err);
});

module.exports = bot;
