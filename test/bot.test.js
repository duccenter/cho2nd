const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { describeError } = require('../src/errors');

function loadHandlers(env = {}, database = {}) {
    const commands = new Map();
    const actions = new Map();
    const events = new Map();
    class TestBot {
        command(names, handler) { for (const name of [names].flat()) commands.set(name, handler); }
        action(name, handler) { actions.set(name, handler); }
        on(name, handler) { events.set(name, handler); }
        catch() {}
    }
    const db = { User: { findOneAndUpdate: async () => ({ trust_score: 1 }) }, ...database };
    vm.runInNewContext(fs.readFileSync(require.resolve('../src/bot'), 'utf8'), {
        require: name => {
            if (name === 'telegraf') return { Telegraf: TestBot };
            if (name === './errors') return { describeError };
            if (name === './database') return db;
            throw new Error(`Unexpected require: ${name}`);
        },
        process: { env: { BOT_TOKEN: '123:offline-test', ...env } },
        module: { exports: {} }, console, setTimeout
    });
    return { commands, actions, events };
}

test('a Telegram mention invokes Batam only for this bot, without forwarding replies or other mentions', async () => {
    const { events } = loadHandlers();
    const searches = [];
    const handler = events.get('message');
    const ctx = text => ({ chat: { type: 'supergroup', id: -1001 }, from: { id: 42 }, me: 'batam_2nd_bot',
        message: { text, message_thread_id: 9 },
        museBridge: { commands: { search: async (_ctx, query) => searches.push(query) } } });
    const mentioned = ctx('@BATAM_2ND_BOT tìm iPhone cũ tại Huế');
    mentioned.message.entities = [{ type: 'mention', offset: 0, length: 14 }];
    await handler(mentioned);
    assert.deepEqual(searches, ['tìm iPhone cũ tại Huế']);
    const other = ctx('@other_bot tìm máy ảnh');
    other.message.entities = [{ type: 'mention', offset: 0, length: 10 }];
    await handler(other);
    const question = ctx('@batam_2nd_bot Giải thích lạm phát bằng ví dụ dễ hiểu');
    question.message.entities = [{ type: 'mention', offset: 0, length: 14 }];
    await handler(question);
    assert.equal(searches[1], 'Giải thích lạm phát bằng ví dụ dễ hiểu');
    const ordinary = ctx('Tôi cần máy ảnh');
    ordinary.message.reply_to_message = { from: { is_bot: true } };
    await handler(ordinary);
    assert.equal(searches.length, 2);
});

test('private text starts a search but active draft answers and slash commands keep their original route', async () => {
    let user = null;
    const updates = [];
    const { events, commands } = loadHandlers({}, { User: {
        findOne: async () => user,
        updateOne: async (...args) => updates.push(args)
    } });
    const searches = [];
    const replies = [];
    const ctx = { chat: { type: 'private', id: 42 }, from: { id: 42 }, message: { text: 'tìm iPhone cũ ở HCM' },
        museBridge: { commands: { search: async (_ctx, text) => searches.push(text) } },
        reply: async text => replies.push(text) };
    await events.get('message')(ctx);
    assert.deepEqual(searches, ['tìm iPhone cũ ở HCM']);
    user = { _id: 'user', post_builder_state: 'waiting_name' };
    ctx.message.text = 'iPhone của tôi';
    await events.get('message')(ctx);
    assert.equal(updates.length, 1);
    assert.equal(searches.length, 1);
    ctx.message.text = '/unknown';
    await events.get('message')(ctx);
    assert.equal(searches.length, 1);
    assert.equal(commands.has('batam'), true);
    assert.equal(commands.has('batam_status'), true);
    assert.equal(commands.has('batam_new'), true);
    assert.equal(commands.has('muse_new'), true);
    assert.equal(commands.has('muse'), true);
});

test('a draft lookup failure never forwards private draft text to the agent', async () => {
    const { events } = loadHandlers({}, { User: { findOne: async () => { throw new Error('offline'); } } });
    let searched = false;
    await events.get('message')({ chat: { type: 'private' }, from: { id: 42 }, message: { text: 'draft answer' },
        museBridge: { commands: { search: async () => { searched = true; } } }, reply: async () => {} });
    assert.equal(searched, false);
});

for (const env of [{}, { ENABLE_JOIN_CAPTCHA: 'false' }]) {
    test(`new members are welcomed in General without muting (captcha=${env.ENABLE_JOIN_CAPTCHA || 'unset'})`, async () => {
        const { events } = loadHandlers(env);
        const sent = [];
        let restrictions = 0;
        await events.get('new_chat_members')({
            chat: { id: -1001 },
            message: { message_thread_id: 9, new_chat_members: [
                { id: 42, first_name: 'An_[test]', is_bot: false },
                { id: 43, username: 'Binh', is_bot: false },
                { id: 44, is_bot: true }
            ] },
            telegram: {
                sendMessage: async (...args) => { sent.push(args); },
                restrictChatMember: async () => { restrictions++; }
            }
        });
        assert.equal(restrictions, 0);
        assert.equal(sent.length, 2);
        assert.equal(sent[0][0], -1001);
        assert.match(sent[0][1], /An_\[test\]/);
        assert.match(sent[1][1], /Binh/);
        assert.match(sent[0][1], /Sảnh Chung dành cho thông báo/);
        assert.equal(sent[0].length, 2, 'no thread ID, Markdown parsing or verification buttons');
    });
}

test('unlock restores group defaults without granting topic management', async () => {
    const { actions } = loadHandlers({ GROUP_CHAT_ID: '-1001' });
    const permissions = { can_send_messages: true, can_send_photos: true, can_manage_topics: false, can_pin_messages: false, can_change_info: false };
    let restored;
    await actions.get('mo_khoa')({
        chat: { type: 'private' }, from: { id: 42 },
        telegram: {
            getChatMember: async () => ({ status: 'restricted', until_date: 0 }),
            getChat: async () => ({ permissions }),
            restrictChatMember: async (chatId, userId, options) => { restored = { chatId, userId, options }; }
        },
        reply: async () => {}, answerCbQuery: async () => {}
    });
    assert.equal(restored.chatId, '-1001');
    assert.equal(restored.userId, 42);
    assert.equal(restored.options.permissions, permissions);
    assert.equal(restored.options.use_independent_chat_permissions, true);
});

test('failed reputation replies remain in the handler promise', async () => {
    const { commands } = loadHandlers();
    let attempts = 0;
    await assert.rejects(commands.get('uytin')({
        message: { from: { id: 1 }, reply_to_message: { from: { id: 2, first_name: 'Seller' } } },
        reply: async () => { attempts++; throw new Error('Telegram reply rejected'); }
    }), /Telegram reply rejected/);
    assert.equal(attempts, 2);
});

test('failed callback acknowledgements remain in the handler promise', async () => {
    const { actions } = loadHandlers();
    await assert.rejects(actions.get('huong_dan')({
        reply: async () => {}, answerCbQuery: async () => { throw new Error('Query expired'); }
    }), /Query expired/);
});

test('logs redact bot tokens and database credentials', () => {
    const token = '123:secret-token';
    const uri = 'mongodb+srv://user:password@cluster.example/cho2nd';
    const result = describeError(new Error(`Request https://api.telegram.org/bot${token}/getMe ${uri}`), { BOT_TOKEN: token, MONGO_URI: uri });
    assert.ok(!result.includes(token));
    assert.ok(!result.includes('password'));
});

test('privileged commands reject a copied username, demoted admins and failed lookups', async () => {
    let writes = 0;
    const { commands } = loadHandlers({ GROUP_CHAT_ID: '-1001', ADMIN_USER_IDS: '42' }, {
        Scammer: { create: async () => { writes++; } }
    });
    for (const scenario of [
        { id: 7, status: 'administrator' },
        { id: 42, status: 'member' },
        { id: 42, error: true },
        { id: 42, status: 'creator', chat: { type: 'supergroup', id: -1002 } }
    ]) {
        const replies = [];
        await commands.get('scam')({
            from: { id: scenario.id, username: 'pduc_diticoms' },
            chat: scenario.chat || { type: 'private' }, message: { text: '/scam example reason' },
            telegram: { getChatMember: async () => {
                if (scenario.error) throw new Error('offline');
                return { status: scenario.status };
            } },
            reply: async text => replies.push(text)
        });
        assert.match(replies[0], /Chỉ quản trị viên/);
    }
    assert.equal(writes, 0);
    assert.equal(commands.has('testpromote'), false);
});

test('configured numeric admin ID works without a username and records the ID', async () => {
    let record;
    const { commands } = loadHandlers({ GROUP_CHAT_ID: '-1001', ADMIN_USER_IDS: ' 42,43 ' }, {
        Scammer: { create: async data => { record = data; } }
    });
    await commands.get('scam')({
        from: { id: 42 }, chat: { type: 'private' }, message: { text: '/scam example reason' },
        telegram: { getChatMember: async (chat, id) => {
            assert.equal(chat, '-1001'); assert.equal(id, 42); return { status: 'creator' };
        } }, reply: async () => {}
    });
    assert.equal(record.added_by, '42');
});

test('subscription deletion is private, validates IDs and atomically checks ownership', async () => {
    const ownId = '1234567890abcdef12345678';
    const otherId = 'abcdef1234567890abcdef12';
    const records = new Map([[ownId, '42'], [otherId, '43']]);
    let deletions = 0;
    const { actions } = loadHandlers({}, { Subscription: {
        findOneAndDelete: async filter => {
            deletions++;
            if (records.get(filter._id) !== filter.telegram_id) return null;
            records.delete(filter._id); return { _id: filter._id };
        }, find: async () => []
    } });
    const handler = [...actions].find(([key]) => String(key) === '/^delsub_(.+)$/')[1];
    const answers = [];
    const invoke = (id, type = 'private') => handler({
        match: ['', id], from: { id: 42 }, chat: { type },
        answerCbQuery: async text => answers.push(text), editMessageText: async () => {}
    });
    await invoke('invalid'); await invoke(ownId, 'supergroup');
    assert.equal(deletions, 0);
    await invoke(otherId);
    assert.equal(records.has(otherId), true);
    assert.match(answers.at(-1), /Không tìm thấy/);
    await invoke(ownId);
    assert.equal(records.has(ownId), false);
    assert.match(answers.at(-1), /thành công/);
});

for (const count of [3, 10, 50]) {
    test(`referral reward at ${count} invites never grants admin rights`, async () => {
        const { events } = loadHandlers({}, { User: { findOneAndUpdate: async () => ({ invite_count: count, telegram_id: '42' }) } });
        const replies = [];
        await events.get('chat_member')({
            chatMember: { old_chat_member: { status: 'left' }, new_chat_member: { status: 'member', user: { first_name: 'An' } }, invite_link: { name: 'ref_42' } },
            telegram: new Proxy({}, { get: () => () => assert.fail('Referral rewards must not call Telegram admin APIs') }),
            reply: async text => replies.push(text)
        });
        assert.match(replies[0], /Danh hiệu trong hồ sơ/);
    });
}
