const { Telegraf, Markup } = require('telegraf');
const { User, Subscription } = require('./database');

if (!process.env.BOT_TOKEN) {
    console.error('Lỗi: BOT_TOKEN không được tìm thấy trong biến môi trường.');
    process.exit(1);
}

const bot = new Telegraf(process.env.BOT_TOKEN);
const BAD_WORDS = ['đm', 'vcl', 'địt', 'lồn', 'cặc', 'phò', 'đĩ', 'chó đẻ'];

// --- 1. MENU & START ---
bot.command(['start', 'help', 'menu'], (ctx) => {
    ctx.reply(
        'Chào mừng đến với hệ thống Quản lý Chợ 2nd! Bạn cần giúp gì?',
        Markup.inlineKeyboard([
            [Markup.button.callback('👕 Hướng dẫn Đăng bài', 'huong_dan')],
            [Markup.button.callback('🔔 Săn đồ (Nhận thông báo)', 'san_do')],
            [Markup.button.callback('⭐ Hệ thống Uy tín', 'uy_tin')]
        ])
    );
});

bot.action('huong_dan', (ctx) => {
    ctx.reply('📌 **Hướng dẫn đăng bài:**\nTrong phòng Mua Bán, mọi bài viết BẮT BUỘC phải có hashtag `#ban` hoặc `#mua`.\nNếu bán xong, hãy Reply bài viết của chính bạn và gõ `/daban` để bot dọn rác nhé!', { parse_mode: 'Markdown' });
    ctx.answerCbQuery();
});
bot.action('san_do', (ctx) => {
    ctx.reply('🔔 **Cách săn đồ:**\nĐể nhận thông báo khi có người bán món đồ bạn cần, hãy nhắn tin riêng (Inbox) cho tôi với cú pháp:\n`/sandothue <từ khóa>`\nVí dụ: `/sandothue iphone 13`', { parse_mode: 'Markdown' });
    ctx.answerCbQuery();
});
bot.action('uy_tin', (ctx) => {
    ctx.reply('⭐ **Hệ thống Uy tín:**\n- Để cộng điểm uy tín cho người bán: Hãy Reply tin nhắn của họ và gõ `/uytin`\n- Để kiểm tra uy tín: Gõ `/check @username_nguoiban`', { parse_mode: 'Markdown' });
    ctx.answerCbQuery();
});

// --- 2. TÍNH NĂNG ĐÃ BÁN ---
bot.command('daban', async (ctx) => {
    const repliedMsg = ctx.message.reply_to_message;
    if (!repliedMsg) {
        return ctx.reply('Bạn phải Reply (Trả lời) vào bài đăng bán của chính bạn và gõ /daban.');
    }
    // Chỉ cho phép xóa bài của chính mình hoặc admin (giả định tự reply chính mình)
    if (repliedMsg.from.id !== ctx.message.from.id) {
        return ctx.reply('Bạn chỉ có thể đánh dấu "đã bán" cho bài viết của CHÍNH BẠN!');
    }
    try {
        await ctx.deleteMessage(repliedMsg.message_id); // Xóa bài gốc
        await ctx.deleteMessage(ctx.message.message_id); // Xóa luôn lệnh /daban
        const msg = await ctx.reply(`✅ Cảm ơn bạn, một mặt hàng đã được thanh khoản và dọn dẹp khỏi nhóm!`);
        setTimeout(() => ctx.telegram.deleteMessage(ctx.chat.id, msg.message_id).catch(() => {}), 5000);
    } catch (err) {
        console.error('Lỗi khi xóa bài daban:', err);
    }
});

// --- 3. SĂN ĐỒ (INBOX ONLY) ---
bot.command('sandothue', async (ctx) => {
    if (ctx.chat.type !== 'private') {
        return ctx.reply('⚠️ Tính năng /sandothue chỉ hoạt động khi bạn nhắn tin riêng (Inbox) trực tiếp cho bot!');
    }
    const keyword = ctx.message.text.split(' ').slice(1).join(' ').toLowerCase();
    if (!keyword) {
        return ctx.reply('Vui lòng nhập từ khóa. Ví dụ: /sandothue iphone 13');
    }
    try {
        await Subscription.create({ telegram_id: ctx.message.from.id.toString(), keyword: keyword });
        ctx.reply(`✅ Đã đăng ký nhận thông báo khi có người bán: **${keyword}**`, { parse_mode: 'Markdown' });
    } catch (err) {
        ctx.reply('Lỗi kết nối cơ sở dữ liệu. Hãy kiểm tra biến môi trường MONGO_URI.');
    }
});

// --- 4. UY TÍN (CỘNG ĐIỂM) ---
bot.command('uytin', async (ctx) => {
    const repliedMsg = ctx.message.reply_to_message;
    if (!repliedMsg) return ctx.reply('Bạn phải Reply (Trả lời) vào tin nhắn của người bạn muốn cộng điểm uy tín.');
    if (repliedMsg.from.id === ctx.message.from.id) return ctx.reply('Bạn không thể tự cộng điểm cho chính mình!');
    if (repliedMsg.from.is_bot) return ctx.reply('Không thể cộng điểm cho Bot!');

    try {
        const targetUser = await User.findOneAndUpdate(
            { telegram_id: repliedMsg.from.id.toString() },
            { 
                $inc: { trust_score: 1 },
                $set: { 
                    username: repliedMsg.from.username || '',
                    first_name: repliedMsg.from.first_name || ''
                }
            },
            { upsert: true, new: true }
        );
        ctx.reply(`⭐ Tuyệt vời! Bạn đã cộng 1 điểm uy tín cho **${repliedMsg.from.first_name}**. (Điểm hiện tại: ${targetUser.trust_score})`, { parse_mode: 'Markdown' });
    } catch (err) {
        ctx.reply('Lỗi kết nối cơ sở dữ liệu MongoDB.');
    }
});

// --- 5. CHECK UY TÍN ---
bot.command('check', async (ctx) => {
    const username = ctx.message.text.split(' ')[1];
    if (!username) return ctx.reply('Vui lòng nhập username. Ví dụ: /check @nguoiban');
    const cleanUsername = username.replace('@', '');
    try {
        const user = await User.findOne({ username: cleanUsername });
        if (!user) {
            return ctx.reply(`Chưa có dữ liệu uy tín nào về @${cleanUsername}.`);
        }
        ctx.reply(`⭐ Người dùng **@${cleanUsername}** hiện có **${user.trust_score}** điểm uy tín trên hệ thống!`, { parse_mode: 'Markdown' });
    } catch (err) {
        ctx.reply('Lỗi kết nối cơ sở dữ liệu.');
    }
});

// Lệnh gettopicid (giữ nguyên)
bot.command('gettopicid', (ctx) => {
    if (ctx.message.is_topic_message && ctx.message.message_thread_id) {
        ctx.reply(`📌 **Thông số:**\n1. MUABAN_TOPIC_ID: \`${ctx.message.message_thread_id}\`\n2. GROUP_CHAT_ID: \`${ctx.chat.id}\``, { parse_mode: 'Markdown' });
    } else {
        ctx.reply('Lệnh này chỉ dùng được bên trong một Topic.');
    }
});

// --- 6. KIỂM DUYỆT TỰ ĐỘNG ---
bot.on('text', async (ctx) => {
    const msg = ctx.message;
    const text = msg.text.toLowerCase();
    if (text.startsWith('/')) return;

    if (ctx.chat.type === 'group' || ctx.chat.type === 'supergroup') {
        
        // 6.1. CHỐNG SPAM LINK
        const hasLink = text.includes('http://') || text.includes('https://') || text.includes('t.me/');
        if (hasLink) {
            try {
                // Kiểm tra xem có phải admin không
                const member = await ctx.telegram.getChatMember(ctx.chat.id, msg.from.id);
                if (member.status !== 'creator' && member.status !== 'administrator') {
                    await ctx.deleteMessage(msg.message_id).catch(() => {});
                    const warning = await ctx.reply(`🚫 @${msg.from.username || msg.from.first_name}, bạn không được phép gửi Link quảng cáo trong nhóm!`);
                    setTimeout(() => ctx.telegram.deleteMessage(ctx.chat.id, warning.message_id).catch(() => {}), 10000);
                    return; // Dừng xử lý
                }
            } catch (err) {
                console.error('Lỗi kiểm tra quyền admin:', err);
            }
        }

        // 6.2. LỌC THÔ TỤC
        const hasBadWord = BAD_WORDS.some(word => new RegExp(`\\b${word}\\b`, 'i').test(text));
        if (hasBadWord) {
            try {
                await ctx.deleteMessage(msg.message_id).catch(() => {});
                const untilDate = Math.floor(Date.now() / 1000) + 86400;
                await ctx.telegram.restrictChatMember(ctx.chat.id, msg.from.id, {
                    permissions: { can_send_messages: false },
                    until_date: untilDate
                });
                await ctx.reply(`🚫 @${msg.from.username || msg.from.first_name} đã bị khóa chat 1 ngày do dùng từ thô tục.`);
            } catch (err) {}
            return;
        }

        // 6.3. KIỂM DUYỆT ĐỊNH DẠNG MUA BÁN & GỬI THÔNG BÁO SĂN ĐỒ
        const isTopic = msg.is_topic_message;
        const topicId = msg.message_thread_id;
        const muabanTopicId = process.env.MUABAN_TOPIC_ID ? parseInt(process.env.MUABAN_TOPIC_ID) : null;
        let isMuaBan = false;
        
        if (!muabanTopicId) isMuaBan = true;
        else if (isTopic && topicId === muabanTopicId) isMuaBan = true;

        if (isMuaBan) {
            const hasTag = text.includes('#ban') || text.includes('#mua');
            if (!hasTag) {
                try {
                    const warning = await ctx.reply(`@${msg.from.username || msg.from.first_name}, bài viết sai định dạng (thiếu hashtag #ban hoặc #mua). Vui lòng sửa lại!`);
                    setTimeout(() => ctx.telegram.deleteMessage(ctx.chat.id, warning.message_id).catch(() => {}), 15000);
                } catch (err) {}
            } else {
                // Nếu HỢP LỆ -> Kích hoạt thuật toán SĂN ĐỒ
                try {
                    const subs = await Subscription.find();
                    for (const sub of subs) {
                        if (text.includes(sub.keyword) && sub.telegram_id !== msg.from.id.toString()) {
                            // Bắn tin nhắn riêng cho người đăng ký
                            ctx.telegram.sendMessage(
                                sub.telegram_id, 
                                `🔔 **Hàng mới về!**\nCó người vừa đăng bán mặt hàng liên quan tới từ khóa: **${sub.keyword}**\n\nNội dung:\n"${msg.text}"\n\n(Vào nhóm để xem chi tiết nhé!)`,
                                { parse_mode: 'Markdown' }
                            ).catch(() => { /* Bỏ qua nếu họ đã block bot */ });
                        }
                    }
                } catch (err) {
                    console.error('Lỗi khi quét Săn đồ:', err);
                }
            }
        }
    }
});

bot.catch((err, ctx) => {
    console.error(`Có lỗi xảy ra:`, err);
});

module.exports = bot;
