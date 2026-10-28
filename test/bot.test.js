const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { describeError } = require('../src/errors');

function loadHandlers(env = {}) {
    const commands = new Map();
    const actions = new Map();
    const events = new Map();
    class TestBot {
        command(names, handler) { for (const name of [names].flat()) commands.set(name, handler); }
        action(name, handler) { actions.set(name, handler); }
        on(name, handler) { events.set(name, handler); }
        catch() {}
    }
    const db = { User: { findOneAndUpdate: async () => ({ trust_score: 1 }) } };
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
        assert.match(sent[0][1], /không cần bấm xác nhận/);
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
