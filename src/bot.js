const { Telegraf, Markup } = require('telegraf');
const { User, Subscription, Scammer } = require('./database');
const { describeError } = require('./errors');

if (!process.env.BOT_TOKEN) {
    console.error('Lỗi: BOT_TOKEN không được tìm thấy trong biến môi trường.');
    process.exit(1);
}

const bot = new Telegraf(process.env.BOT_TOKEN);
const BAD_WORDS = ['đm', 'vcl', 'địt', 'lồn', 'cặc', 'phò', 'đĩ', 'chó đẻ'];

// Old /muse commands remain aliases for requests already in flight.
for (const [name, handler] of [['batam', 'search'], ['batam_status', 'status'], ['batam_cancel', 'cancel'],
    ['muse', 'search'], ['muse_status', 'status'], ['muse_cancel', 'cancel']]) {
    bot.command(name, async ctx => {
        if (!ctx.museBridge) return ctx.reply('Tìm kiếm Batam chưa được bật.');
        return ctx.museBridge.commands[handler](ctx);
    });
}

async function canManageBot(ctx) {
    const allowedIds = (process.env.ADMIN_USER_IDS || '').split(',').map(id => id.trim());
    const chatId = process.env.GROUP_CHAT_ID;
    if (!chatId || !allowedIds.includes(String(ctx.from.id))) return false;
    if (ctx.chat.type !== 'private' && String(ctx.chat.id) !== String(chatId)) return false;
    try {
        const member = await ctx.telegram.getChatMember(chatId, ctx.from.id);
        return member.status === 'creator' || member.status === 'administrator';
    } catch {
        return false;
    }
}

async function restoreMemberPermissions(telegram, chatId, userId) {
    const chat = await telegram.getChat(chatId);
    if (!chat.permissions) throw new Error('Không đọc được quyền mặc định của nhóm.');
    await telegram.restrictChatMember(chatId, userId, {
        permissions: chat.permissions,
        use_independent_chat_permissions: true
    });
}

// --- 1. MENU & START ---
bot.command(['start', 'help', 'menu'], async (ctx) => {
    if (ctx.chat && ctx.chat.type !== 'private') {
        try {
            const msg = await ctx.reply('⚠️ Vui lòng nhắn tin riêng (Inbox) cho Bot để xem Menu và sử dụng các tính năng!');
            setTimeout(() => {
                ctx.telegram.deleteMessage(ctx.chat.id, msg.message_id).catch(() => {});
                ctx.deleteMessage().catch(() => {});
            }, 10000);
        } catch (err) {}
        return;
    }

    await ctx.reply(
        'Chào mừng đến với hệ thống Quản lý Chợ 2nd! Bạn cần giúp gì?\n\n🔎 Gõ sản phẩm, khu vực và ngân sách để Batam tìm trên Facebook Marketplace. Trong nhóm, gọi @batam_2nd_bot kèm nhu cầu.',
        Markup.inlineKeyboard([
            [Markup.button.callback('👕 Hướng dẫn Đăng bài', 'huong_dan')],
            [Markup.button.callback('🔔 Săn đồ', 'san_do'), Markup.button.callback('📋 Quản lý đồ săn', 'quanly_btn')],
            [Markup.button.callback('⭐ Hệ thống Uy tín', 'uy_tin'), Markup.button.callback('👤 Hồ sơ cá nhân', 'profile_btn')],
            [Markup.button.callback('🤝 Tạo Link Chia Sẻ', 'tao_link')],
            [Markup.button.callback('✍️ Trợ lý Lên Form', 'tao_form')],
            [Markup.button.callback('🔓 Mở khóa Chat', 'mo_khoa')]
        ])
    );
});

bot.action('huong_dan', async (ctx) => {
    await ctx.reply('📌 **Hướng dẫn đăng bài:**\nTrong phòng Mua Bán, mọi bài viết BẮT BUỘC phải có **Hình Ảnh/Video**, **Giá tiền** và **Số điện thoại**.\nNếu bán xong, hãy Reply bài viết của chính bạn và gõ `/daban` để đóng dấu nhé!', { parse_mode: 'Markdown' });
    await ctx.answerCbQuery();
});
bot.action('san_do', async (ctx) => {
    await ctx.reply('🔔 **Cách săn đồ:**\nĐể nhận thông báo khi có người bán món đồ bạn cần, hãy nhắn tin riêng (Inbox) cho tôi với cú pháp:\n`/tim <từ khóa>`\nVí dụ: `/tim iphone 13`', { parse_mode: 'Markdown' });
    await ctx.answerCbQuery();
});
bot.action('uy_tin', async (ctx) => {
    await ctx.reply('⭐ **Hệ thống Uy tín:**\n- Để cộng điểm uy tín cho người bán: Hãy Reply tin nhắn của họ và gõ `/uytin`\n- Để tra cứu SĐT hoặc Username có lừa đảo không: Gõ `/check <sdt/username>`', { parse_mode: 'Markdown' });
    await ctx.answerCbQuery();
});

bot.action('tao_link', async (ctx) => {
    if (ctx.chat.type !== 'private') {
        return ctx.reply('⚠️ Vui lòng nhắn tin riêng (Inbox) cho Bot và gõ /menu để tạo link chia sẻ nhé!');
    }
    
    const chatId = process.env.GROUP_CHAT_ID;
    if (!chatId) {
        return ctx.reply('Chưa cấu hình GROUP_CHAT_ID.');
    }
    
    try {
        const inviteLink = await ctx.telegram.createChatInviteLink(chatId, {
            name: `ref_${ctx.from.id}`,
            creates_join_request: false
        });
        
        await ctx.reply(`🎉 **Đây là Link Giới Thiệu Độc Quyền của bạn:**\n\n${inviteLink.invite_link}\n\nKhi có người tham gia nhóm thông qua link này, bạn sẽ được:\n- Cộng 2 Điểm Uy Tín\n- Nhận danh hiệu trong hồ sơ ở mốc 3, 10, 50 người (không cấp quyền quản trị nhóm).`, { parse_mode: 'Markdown' });
    } catch (err) {
        console.error('Lỗi tạo link:', err);
        await ctx.reply('❌ Có lỗi xảy ra. Vui lòng đảm bảo Bot là Admin của nhóm và có quyền "Invite Users" (Thêm thành viên).');
    }
    await ctx.answerCbQuery();
});

// --- XỬ LÝ MỞ KHÓA CHAT ---
bot.action('mo_khoa', async (ctx) => {
    if (ctx.chat.type !== 'private') return ctx.answerCbQuery();
    const chatId = process.env.GROUP_CHAT_ID;
    if (!chatId) return ctx.reply('⚠️ Chưa cấu hình ID Nhóm.');

    try {
        const member = await ctx.telegram.getChatMember(chatId, ctx.from.id);
        
        // Nếu đang bị cấm chat có thời hạn (do vi phạm luật)
        if (member.status === 'restricted' && member.until_date && member.until_date > Math.floor(Date.now() / 1000)) {
            return ctx.reply('🚫 TÀI KHOẢN BỊ PHẠT: Bạn đang trong thời gian bị khóa mõm do vi phạm nội quy (chửi thề, spam...). Hãy đợi hết thời gian phạt nhé!');
        }

        if (member.status === 'left' || member.status === 'kicked') {
            return ctx.reply('⚠️ Bạn hiện không có mặt trong nhóm Chợ 2nd!');
        }

        // Mở khóa
        await restoreMemberPermissions(ctx.telegram, chatId, ctx.from.id);
        await ctx.reply('✅ **MỞ KHÓA THÀNH CÔNG!**\n\nBạn đã có thể nhắn tin và đăng bài trong nhóm Chợ 2nd. Chúc bạn mua may bán đắt!', { parse_mode: 'Markdown' });
    } catch (err) {
        await ctx.reply('❌ Có lỗi xảy ra, Bot không đủ quyền hạn hoặc bạn không ở trong nhóm.');
    }
    await ctx.answerCbQuery();
});

// --- XỬ LÝ TRỢ LÝ LÊN FORM ---
bot.action('tao_form', async (ctx) => {
    if (ctx.chat.type !== 'private') {
        return ctx.reply('⚠️ Tính năng này chỉ dùng trong Tin nhắn riêng (Inbox) với Bot!');
    }
    try {
        await User.findOneAndUpdate(
            { telegram_id: ctx.from.id.toString() },
            { $set: { post_builder_state: 'waiting_name', post_draft: {} } },
            { upsert: true }
        );
        await ctx.reply('Bắt đầu lên form bài viết! \n\n1️⃣ **Bạn đang bán sản phẩm gì?** (Ví dụ: iPhone 13 Pro Max)\n*(Gõ /cancel bất cứ lúc nào để thoát)*', { parse_mode: 'Markdown' });
    } catch (err) {
        await ctx.reply('Lỗi hệ thống.');
    }
    await ctx.answerCbQuery();
});

bot.command('cancel', async (ctx) => {
    if (ctx.chat.type === 'private') {
        try {
            await User.findOneAndUpdate(
                { telegram_id: ctx.from.id.toString() },
                { $set: { post_builder_state: 'none', post_draft: {} } }
            );
            await ctx.reply('Đã hủy quá trình tạo form bài viết.');
        } catch (err) {}
    }
});

// --- THẺ PROFILE ---
const handleProfile = async (ctx) => {
    try {
        const user = await User.findOne({ telegram_id: ctx.from.id.toString() });
        if (!user) {
            return ctx.reply('⚠️ Bạn chưa có hồ sơ trên hệ thống. Hãy tương tác nhiều hơn để hệ thống ghi nhận nhé!');
        }

        let customTitle = "Thành viên Tập sự";
        const count = user.invite_count || 0;
        if (count >= 50) customTitle = "Ông Trùm Chợ 2nd";
        else if (count >= 10) customTitle = "Khách Hàng VIP";
        else if (count >= 3) customTitle = "Chiến Thần Chốt Đơn";
        else if (user.trust_score > 0) customTitle = "Thương Nhân Uy Tín";

        const joinedDate = new Date(user.joined_at || Date.now()).toLocaleDateString('vi-VN');

        const profileText = `🪪 **THẺ CĂN CƯỚC CHỢ 2ND**\n\n` +
            `👤 **Tên:** ${user.first_name || ctx.from.first_name}\n` +
            `👑 **Chức danh:** ${customTitle}\n` +
            `⭐ **Điểm Uy Tín:** ${user.trust_score || 0}\n` +
            `🤝 **Số người đã mời:** ${count}\n` +
            `📅 **Gia nhập:** ${joinedDate}\n\n` +
            `*(Giao dịch uy tín và mời thêm bạn bè để nâng cấp tước hiệu nhé!)*`;

        await ctx.reply(profileText, { parse_mode: 'Markdown' });
    } catch (err) {
        await ctx.reply('Lỗi truy xuất hồ sơ.');
    }
    if (ctx.callbackQuery) await ctx.answerCbQuery();
};
bot.command('profile', handleProfile);
bot.action('profile_btn', handleProfile);

// --- QUẢN LÝ SĂN ĐỒ ---
const handleQuanLy = async (ctx) => {
    if (ctx.chat && ctx.chat.type !== 'private') {
        const msg = await ctx.reply('⚠️ Vui lòng nhắn tin riêng (Inbox) cho Bot để quản lý đồ đang săn!');
        setTimeout(() => ctx.telegram.deleteMessage(ctx.chat.id, msg.message_id).catch(() => {}), 10000);
        if (ctx.callbackQuery) await ctx.answerCbQuery();
        return;
    }
    
    try {
        const subs = await Subscription.find({ telegram_id: ctx.from.id.toString() });
        if (subs.length === 0) {
            await ctx.reply('🛒 Bạn chưa đăng ký theo dõi món đồ nào cả.\nHãy dùng lệnh `/tim <từ khóa>` để bắt đầu săn đồ nhé!', { parse_mode: 'Markdown' });
            if (ctx.callbackQuery) await ctx.answerCbQuery();
            return;
        }

        const keyboard = [];
        for (const sub of subs) {
            keyboard.push([{ text: `❌ Ngừng theo dõi: ${sub.keyword}`, callback_data: `delsub_${sub._id}` }]);
        }

        await ctx.reply('📋 **Danh sách các món đồ bạn đang theo dõi:**\n(Bấm vào nút ❌ bên dưới để ngừng thông báo món đồ đó)', {
            parse_mode: 'Markdown',
            reply_markup: {
                inline_keyboard: keyboard
            }
        });
    } catch (err) {
        await ctx.reply('Lỗi truy xuất danh sách.');
    }
    if (ctx.callbackQuery) await ctx.answerCbQuery();
};
bot.command('quanly', handleQuanLy);
bot.action('quanly_btn', handleQuanLy);

bot.action(/^delsub_(.+)$/, async (ctx) => {
    const subId = ctx.match[1];
    if (ctx.chat.type !== 'private' || !/^[a-f\d]{24}$/i.test(subId)) {
        return ctx.answerCbQuery('❌ Yêu cầu không hợp lệ.', { show_alert: true });
    }
    try {
        const removed = await Subscription.findOneAndDelete({ _id: subId, telegram_id: String(ctx.from.id) });
        if (!removed) return ctx.answerCbQuery('❌ Không tìm thấy đăng ký của bạn.', { show_alert: true });
        await ctx.answerCbQuery('✅ Đã ngừng theo dõi thành công!', { show_alert: true });
        
        // Tải lại danh sách
        const subs = await Subscription.find({ telegram_id: ctx.from.id.toString() });
        if (subs.length === 0) {
            await ctx.editMessageText('🛒 Bạn không còn theo dõi món đồ nào nữa.');
        } else {
            const keyboard = [];
            for (const sub of subs) {
                keyboard.push([{ text: `❌ Ngừng theo dõi: ${sub.keyword}`, callback_data: `delsub_${sub._id}` }]);
            }
            await ctx.editMessageReplyMarkup({ inline_keyboard: keyboard });
        }
    } catch (err) {
        await ctx.answerCbQuery('❌ Có lỗi xảy ra khi xóa.');
    }
});



// --- 2. TÍNH NĂNG ĐÃ BÁN (GIỮ LẠI BÀI) ---
bot.command('daban', async (ctx) => {
    const repliedMsg = ctx.message.reply_to_message;
    if (!repliedMsg) {
        return ctx.reply('Bạn phải Reply (Trả lời) vào bài đăng bán của chính bạn và gõ /daban.');
    }
    // Chỉ cho phép đánh dấu bài của chính mình hoặc admin
    if (repliedMsg.from.id !== ctx.message.from.id) {
        return ctx.reply('Bạn chỉ có thể đánh dấu "đã bán" cho bài viết của CHÍNH BẠN!');
    }
    try {
        await ctx.deleteMessage(ctx.message.message_id); // Xóa luôn lệnh /daban
        await ctx.reply(`❌ **SẢN PHẨM NÀY ĐÃ ĐƯỢC BÁN!**\n\n*(Bài viết được giữ lại để mọi người tham khảo giá)*`, { 
            reply_to_message_id: repliedMsg.message_id,
            parse_mode: 'Markdown'
        });
    } catch (err) {
        console.error('Lỗi khi đánh dấu daban:', err);
    }
});

// --- 3. SĂN ĐỒ (INBOX ONLY) ---
bot.command('tim', async (ctx) => {
    if (ctx.chat.type !== 'private') {
        return ctx.reply('⚠️ Tính năng /tim chỉ hoạt động khi bạn nhắn tin riêng (Inbox) trực tiếp cho bot!');
    }
    const keyword = ctx.message.text.split(' ').slice(1).join(' ').toLowerCase();
    if (!keyword) {
        return ctx.reply('Vui lòng nhập từ khóa. Ví dụ: /tim iphone 13');
    }
    try {
        await Subscription.create({ telegram_id: ctx.message.from.id.toString(), keyword: keyword });
        await ctx.reply(`✅ Đã đăng ký nhận thông báo khi có người bán: **${keyword}**`, { parse_mode: 'Markdown' });
    } catch (err) {
        await ctx.reply('Lỗi kết nối cơ sở dữ liệu. Hãy kiểm tra biến môi trường MONGO_URI.');
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
        await ctx.reply(`⭐ Tuyệt vời! Bạn đã cộng 1 điểm uy tín cho **${repliedMsg.from.first_name}**. (Điểm hiện tại: ${targetUser.trust_score})`, { parse_mode: 'Markdown' });
    } catch (err) {
        await ctx.reply('Lỗi kết nối cơ sở dữ liệu MongoDB.');
    }
});

// --- 5. LỆNH SCAM (THÊM SỔ ĐEN) ---
bot.command('scam', async (ctx) => {
    if (!await canManageBot(ctx)) {
        return ctx.reply('🚫 Chỉ quản trị viên được cấu hình mới có quyền thêm vào Sổ Đen!');
    }
    
    const args = ctx.message.text.split(' ').slice(1);
    if (args.length === 0) {
        return ctx.reply('Vui lòng nhập Username hoặc SĐT. Ví dụ: /scam 0987654321 Lừa đảo tiền cọc');
    }
    
    const target = args[0].replace('@', '').toLowerCase();
    const reason = args.slice(1).join(' ') || "Lừa đảo";
    
    try {
        await Scammer.create({ target: target, reason: reason, added_by: String(ctx.from.id) });
        await ctx.reply(`🚨 **ĐÃ ĐƯA VÀO SỔ ĐEN:** \`${target}\`\nLý do: ${reason}`, { parse_mode: 'Markdown' });
    } catch (err) {
        if (err.code === 11000) {
            await ctx.reply(`⚠️ Mục tiêu \`${target}\` đã có sẵn trong Sổ Đen rồi!`, { parse_mode: 'Markdown' });
        } else {
            await ctx.reply('Lỗi cơ sở dữ liệu.');
        }
    }
});

// --- 6. CHECK UY TÍN & SỔ ĐEN ---
bot.command('check', async (ctx) => {
    const target = ctx.message.text.split(' ')[1];
    if (!target) return ctx.reply('Vui lòng nhập SĐT hoặc Username. Ví dụ: /check 0987654321');
    const cleanTarget = target.replace('@', '').toLowerCase();
    
    try {
        // Kiểm tra Sổ Đen trước
        const scammer = await Scammer.findOne({ target: cleanTarget });
        if (scammer) {
            return ctx.reply(`🚨 **CẢNH BÁO LỪA ĐẢO CỰC KỲ NGUY HIỂM!** 🚨\n\nĐối tượng \`${cleanTarget}\` NẰM TRONG SỔ ĐEN!\nLý do: **${scammer.reason}**\n\nTUYỆT ĐỐI KHÔNG GIAO DỊCH!`, { parse_mode: 'Markdown' });
        }

        // Nếu không có trong Sổ Đen, kiểm tra điểm uy tín (chỉ hoạt động với username)
        const user = await User.findOne({ username: cleanTarget });
        if (!user) {
            return ctx.reply(`Chưa có dữ liệu uy tín nào về ${cleanTarget} trên hệ thống.`);
        }
        await ctx.reply(`⭐ Người dùng **@${cleanTarget}** hiện có **${user.trust_score}** điểm uy tín trên hệ thống!`, { parse_mode: 'Markdown' });
    } catch (err) {
        await ctx.reply('Lỗi kết nối cơ sở dữ liệu.');
    }
});

// Lệnh testnews
bot.command('testnews', async (ctx) => {
    if (ctx.chat.type === 'private') {
        return ctx.reply('Lệnh này chỉ dùng được trong nhóm để tự động nhận diện quyền Admin.');
    }
    
    if (!await canManageBot(ctx)) return;
    
    const news = require('./news');
    await ctx.reply('Đang lấy tin tức, vui lòng chờ...');
    try {
        const message = await news.getDailyNewsMessage();
        if (message) {
            await ctx.reply(message, { parse_mode: 'Markdown', disable_web_page_preview: false });
        } else {
            await ctx.reply('Không tìm thấy tin tức mới nào trong 24h qua.');
        }
    } catch (err) {
        await ctx.reply('Lỗi khi lấy tin tức: ' + err.message);
    }
});

// Lệnh gettopicid
bot.command('gettopicid', async (ctx) => {
    if (ctx.message.is_topic_message && ctx.message.message_thread_id) {
        await ctx.reply(`📌 **Thông số:**\n1. MUABAN_TOPIC_ID (của phòng này): \`${ctx.message.message_thread_id}\`\n2. GROUP_CHAT_ID: \`${ctx.chat.id}\`\n\n*(Lưu ý: Nếu có nhiều phòng, hãy ghép các số ID phòng thành 1 chuỗi ngăn cách bằng dấu phẩy, ví dụ: 336,333,330,2)*`, { parse_mode: 'Markdown' });
    } else {
        await ctx.reply('Lệnh này chỉ dùng được bên trong một Topic.');
    }
});

// --- CHÀO MỪNG & CAPTCHA NGƯỜI MỚI ---
bot.on('new_chat_members', async (ctx) => {
    const newMembers = ctx.message.new_chat_members;
    for (const member of newMembers) {
        if (member.is_bot) continue;
        const name = member.first_name || member.username || 'Thành viên mới';
        
        try {
            if (process.env.ENABLE_JOIN_CAPTCHA !== 'true') {
                // Không truyền thread ID để lời chào luôn gửi vào Sảnh Chung.
                await ctx.telegram.sendMessage(
                    ctx.chat.id,
                    `👋 Chào mừng ${name} đến với Chợ 2nd!\n\n📌 Sảnh Chung dành cho thông báo. Hãy vào Topic Thảo Luận - Hỏi Đáp để trò chuyện hoặc chọn Topic mua bán phù hợp để đăng bài.\n\n🤝 Chúc bạn giao lưu vui vẻ, mua may bán đắt!`
                );
                continue;
            }

            await ctx.telegram.restrictChatMember(ctx.chat.id, member.id, {
                permissions: { can_send_messages: false }
            });

            const captchaMsg = await ctx.telegram.sendMessage(
                ctx.chat.id,
                `👋 Chào mừng **${name}** đã tham gia Chợ 2nd!\n\n⚠️ Để bảo vệ nhóm khỏi Bot tự động, vui lòng bấm nút bên dưới để mở khóa chat! (Tin nhắn tự hủy sau 2 phút)`,
                {
                    parse_mode: 'Markdown',
                    reply_markup: {
                        inline_keyboard: [
                            [{ text: '✅ Tôi là người thật (Mở khóa)', callback_data: `captcha_${member.id}` }]
                        ]
                    }
                }
            );

            // Tự động dọn rác: Xóa nút Captcha sau 2 phút để không làm rác Sảnh Chung
            setTimeout(() => {
                ctx.telegram.deleteMessage(ctx.chat.id, captchaMsg.message_id).catch(() => {});
            }, 120000);
        } catch (err) {
            console.error('Lỗi khi chào đón thành viên mới:', describeError(err));
        }
    }
});

bot.action(/captcha_(.+)/, async (ctx) => {
    const targetId = ctx.match[1];
    if (ctx.from.id.toString() !== targetId) {
        return ctx.answerCbQuery('⚠️ Nút này không dành cho bạn!', { show_alert: true });
    }

    try {
        await restoreMemberPermissions(ctx.telegram, ctx.chat.id, parseInt(targetId));
        
        await ctx.answerCbQuery('✅ Xác thực thành công! Bạn đã có thể chat.');
        await ctx.deleteMessage();
    } catch (err) {
        await ctx.answerCbQuery('❌ Lỗi mở khóa.');
    }
});

// --- XỬ LÝ NHẬN DIỆN LINK GIỚI THIỆU ---
bot.on('chat_member', async (ctx) => {
    const newMember = ctx.chatMember.new_chat_member;
    const oldMember = ctx.chatMember.old_chat_member;
    const inviteLink = ctx.chatMember.invite_link;

    const isJoining = (oldMember.status === 'left' || oldMember.status === 'kicked') && newMember.status === 'member';

    if (isJoining && inviteLink && inviteLink.name && inviteLink.name.startsWith('ref_')) {
        const inviterId = inviteLink.name.split('_')[1];
        
        try {
            // Cập nhật Database
            const inviter = await User.findOneAndUpdate(
                { telegram_id: inviterId },
                { $inc: { trust_score: 2, invite_count: 1 } },
                { new: true }
            );

            if (inviter) {
                let customTitle = null;
                const count = inviter.invite_count;
                
                if (count === 3) customTitle = "Chiến Thần Chốt Đơn";
                else if (count === 10) customTitle = "Khách Hàng VIP";
                else if (count === 50) customTitle = "Ông Trùm Chợ 2nd";

                let titleMsg = '';
                if (customTitle) titleMsg = `\n👑 Danh hiệu trong hồ sơ: **"${customTitle}"** (không cấp quyền quản trị).`;

                await ctx.reply(`🎉 Người mới **${newMember.user.first_name}** vừa gia nhập!\n\n👏 Người giới thiệu: [${inviter.first_name || 'Thành viên'}](tg://user?id=${inviter.telegram_id})\n🎁 Phần thưởng: +2 Điểm Uy Tín (Tổng đã mời: ${count} người)${titleMsg}`, { parse_mode: 'Markdown' });
            }
        } catch (err) {
            console.error('Lỗi xử lý refer:', err);
        }
    }
});

// --- 7. KIỂM DUYỆT TỰ ĐỘNG & POST BUILDER ---
bot.on('message', async (ctx) => {
    const msg = ctx.message;
    const text = (msg.text || msg.caption || '');
    const isPrivate = ctx.chat.type === 'private';

    // Only an explicit mention of this bot starts a search in a group.
    // Use Telegram entities: quoted replies, similar names and normal group
    // conversation must not be forwarded to the search agent.
    if (!isPrivate && msg.text && !msg.text.startsWith('/') && ctx.museBridge && ctx.me) {
        const mentions = (msg.entities || []).filter(entity => entity.type === 'mention' &&
            msg.text.slice(entity.offset, entity.offset + entity.length).toLowerCase() === `@${ctx.me.toLowerCase()}`);
        if (mentions.length) {
            let query = msg.text;
            for (const entity of [...mentions].sort((a, b) => b.offset - a.offset)) {
                query = query.slice(0, entity.offset) + query.slice(entity.offset + entity.length);
            }
            return ctx.museBridge.commands.search(ctx, query.trim());
        }
    }

    // XỬ LÝ INBOX (POST BUILDER)
    if (isPrivate && msg.text && !msg.text.startsWith('/')) {
        try {
            const user = await User.findOne({ telegram_id: ctx.from.id.toString() });
            if (user && user.post_builder_state !== 'none') {
                const state = user.post_builder_state;
                const draft = user.post_draft || {};

                if (state === 'waiting_name') {
                    draft.name = msg.text;
                    await User.updateOne({ _id: user._id }, { post_builder_state: 'waiting_condition', post_draft: draft });
                    return ctx.reply('2️⃣ **Tình trạng sản phẩm ra sao?** (Ví dụ: Mới 99%, zin ốc, xước nhẹ...)', { parse_mode: 'Markdown' });
                }
                if (state === 'waiting_condition') {
                    draft.condition = msg.text;
                    await User.updateOne({ _id: user._id }, { post_builder_state: 'waiting_price', post_draft: draft });
                    return ctx.reply('3️⃣ **Giá bạn muốn bán là bao nhiêu?** (Ví dụ: 15.500.000 VNĐ)', { parse_mode: 'Markdown' });
                }
                if (state === 'waiting_price') {
                    draft.price = msg.text;
                    await User.updateOne({ _id: user._id }, { post_builder_state: 'waiting_area', post_draft: draft });
                    return ctx.reply('4️⃣ **Khu vực giao dịch của bạn ở đâu?** (Ví dụ: Quận 1, TP.HCM / Ship COD toàn quốc)', { parse_mode: 'Markdown' });
                }
                if (state === 'waiting_area') {
                    draft.area = msg.text;
                    await User.updateOne({ _id: user._id }, { post_builder_state: 'waiting_phone', post_draft: draft });
                    return ctx.reply('5️⃣ **Số điện thoại liên hệ của bạn?** (Ví dụ: 0987654321)', { parse_mode: 'Markdown' });
                }
                if (state === 'waiting_phone') {
                    draft.phone = msg.text;
                    await User.updateOne({ _id: user._id }, { post_builder_state: 'none', post_draft: {} });
                    
                    const finalPost = `📦 **SẢN PHẨM:** ${draft.name}\n\n` +
                                      `✨ **Tình trạng:** ${draft.condition}\n` +
                                      `💰 **Giá bán:** ${draft.price}\n` +
                                      `📍 **Khu vực:** ${draft.area}\n` +
                                      `📞 **Liên hệ:** ${draft.phone}\n\n` +
                                      `*(Vui lòng copy đoạn văn bản trên, ra ngoài nhóm đính kèm hình ảnh và gửi đi)*`;
                                      
                    return ctx.reply(finalPost, { parse_mode: 'Markdown' });
                }
            }
        } catch (err) {
            // Do not forward a possible draft answer when its form state
            // could not be read from MongoDB.
            console.error('Không đọc được trạng thái tạo bài:', describeError(err));
            return ctx.reply('Chưa đọc được trạng thái tạo bài. Vui lòng thử lại sau.');
        }
        if (ctx.museBridge) return ctx.museBridge.commands.search(ctx, msg.text);
    }

    // Bỏ qua nếu là các message hệ thống không có media/text trong nhóm
    if (!msg.text && !msg.caption && !msg.photo && !msg.video) return;
    if (text.startsWith('/')) return;

    if (ctx.chat.type === 'group' || ctx.chat.type === 'supergroup') {
        
        // 7.0 KỶ LUẬT SẢNH CHUNG (Không có topic id)
        if (!msg.message_thread_id) {
            try {
                const member = await ctx.telegram.getChatMember(ctx.chat.id, msg.from.id);
                if (member.status !== 'creator' && member.status !== 'administrator') {
                    await ctx.deleteMessage(msg.message_id).catch(() => {});
                    const warning = await ctx.reply(`⚠️ @${msg.from.username || msg.from.first_name}, Sảnh Chung chỉ dùng để nhận thông báo. Vui lòng nhắn tin vào Topic **"1. Thảo Luận - Hỏi Đáp"**!`, { parse_mode: 'Markdown' });
                    setTimeout(() => ctx.telegram.deleteMessage(ctx.chat.id, warning.message_id).catch(() => {}), 10000);
                    return; // Dừng xử lý
                }
            } catch (err) {
                console.error('Lỗi kiểm tra quyền admin Sảnh Chung:', err);
            }
        }

        // 7.1. CHỐNG SPAM LINK
        const hasLink = text.includes('http://') || text.includes('https://') || text.includes('t.me/');
        if (hasLink) {
            try {
                const member = await ctx.telegram.getChatMember(ctx.chat.id, msg.from.id);
                if (member.status !== 'creator' && member.status !== 'administrator') {
                    await ctx.deleteMessage(msg.message_id).catch(() => {});
                    const warning = await ctx.reply(`🚫 @${msg.from.username || msg.from.first_name}, bạn không được phép gửi Link quảng cáo trong nhóm!`);
                    setTimeout(() => ctx.telegram.deleteMessage(ctx.chat.id, warning.message_id).catch(() => {}), 10000);
                    return; 
                }
            } catch (err) {
                console.error('Lỗi kiểm tra quyền admin:', err);
            }
        }

        // 7.2. LỌC THÔ TỤC
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

        // 7.3. KIỂM DUYỆT ĐỊNH DẠNG MUA BÁN
        const isTopic = msg.is_topic_message;
        const topicId = msg.message_thread_id;
        
        const topicIdsStr = process.env.MUABAN_TOPIC_IDS || process.env.MUABAN_TOPIC_ID;
        let muabanTopicIds = [];
        if (topicIdsStr) {
            muabanTopicIds = topicIdsStr.split(',').map(id => parseInt(id.trim())).filter(id => !isNaN(id));
        }

        let isMuaBan = false;
        if (muabanTopicIds.length === 0) {
            isMuaBan = true; // Nếu chưa cấu hình, coi như phòng nào cũng kiểm duyệt
        } else if (isTopic && muabanTopicIds.includes(topicId)) {
            isMuaBan = true;
        }

        if (isMuaBan) {
            if (msg.media_group_id && !msg.caption) return;

            const hasMedia = (msg.photo !== undefined || msg.video !== undefined);
            const hasPrice = /\b(\d+[k|tr|triệu|đ|vnd]|\d{1,3}([\.\,]\d{3})+)\b/i.test(text);
            const hasPhone = /\b(0[3|5|7|8|9])+([0-9]{8})\b/.test(text);

            if (hasMedia && hasPrice && hasPhone) {
                // HỢP LỆ -> Kiểm tra Anti-Flood và Kích hoạt Săn Đồ
                try {
                    const user = await User.findOneAndUpdate(
                        { telegram_id: msg.from.id.toString() },
                        { 
                            $set: { 
                                username: msg.from.username || '',
                                first_name: msg.from.first_name || ''
                            }
                        },
                        { upsert: true, new: true }
                    );

                    const now = new Date();
                    const diffMins = (now - new Date(user.last_posted_at || 0)) / 1000 / 60;

                    if (diffMins < 5) {
                        await ctx.deleteMessage(msg.message_id).catch(() => {});
                        const warning = await ctx.reply(`🚫 @${msg.from.username || msg.from.first_name}, bạn đăng bài quá nhanh! Vui lòng chờ ${Math.ceil(5 - diffMins)} phút nữa để đăng bài tiếp theo.`);
                        setTimeout(() => ctx.telegram.deleteMessage(ctx.chat.id, warning.message_id).catch(() => {}), 10000);
                        return; // Dừng xử lý
                    }

                    user.last_posted_at = now;
                    await user.save();

                    const subs = await Subscription.find();
                    const textLower = text.toLowerCase();
                    for (const sub of subs) {
                        if (textLower.includes(sub.keyword) && sub.telegram_id !== msg.from.id.toString()) {
                            ctx.telegram.sendMessage(
                                sub.telegram_id, 
                                `🔔 **Hàng mới về!**\nCó người vừa đăng bán mặt hàng liên quan tới từ khóa: **${sub.keyword}**\n\nNội dung:\n"${text.substring(0, 50)}..."\n\n(Vào nhóm để xem chi tiết nhé!)`,
                                { parse_mode: 'Markdown' }
                            ).catch(() => {});
                        }
                    }

                } catch (err) {
                    console.error('Lỗi khi xử lý bài hợp lệ:', err);
                }
            }
        }
    }
});

bot.catch((err, ctx) => {
    console.error('Có lỗi xảy ra khi xử lý Telegram:', describeError(err));
});

module.exports = bot;
