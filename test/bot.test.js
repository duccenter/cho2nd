const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { describeError } = require('../src/errors');

function loadHandlers() {
    const commands = new Map();
    const actions = new Map();
    class TestBot {
        command(names, handler) { for (const name of [names].flat()) commands.set(name, handler); }
        action(name, handler) { actions.set(name, handler); }
        on() {}
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
        process: { env: { BOT_TOKEN: '123:offline-test' } },
        module: { exports: {} }, console, setTimeout
    });
    return { commands, actions };
}

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
