const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createService } = require('../src/service');

function fixture(overrides = {}) {
    const { env: envOverrides, ...otherOverrides } = overrides;
    const calls = { schedules: [], sends: [], webhooks: [], updates: [], failures: [], disconnected: 0 };
    let connected = false;
    let resolvePolling;
    let rejectPolling;
    const db = {
        async connectDB() { connected = true; },
        isConnected() { return connected; },
        async disconnectDB() { connected = false; calls.disconnected++; }
    };
    const bot = {
        context: {},
        telegram: {
            async getMe() { return { id: 1, username: 'test_bot' }; },
            async setWebhook(...args) { calls.webhooks.push(args); },
            async sendMessage(...args) { calls.sends.push(args); }
        },
        webhookCallback(_path, _options) {
            return async (req, res) => { calls.updates.push(req.body); res.end(); };
        },
        launch() {
            return new Promise((resolve, reject) => { resolvePolling = resolve; rejectPolling = reject; });
        },
        stop() { resolvePolling(); }
    };
    const service = createService({
        env: {
            BOT_TOKEN: '123:test-token', MONGO_URI: 'mongodb://offline-test', PORT: 0,
            GROUP_CHAT_ID: '-100123', NEWS_TOPIC_ID: '9', CRON_SECRET: 'test-cron-secret',
            ...envOverrides
        },
        bot, db, news: { getDailyNewsMessage: async () => 'Daily news' },
        scheduler: { schedule(...args) { calls.schedules.push(args); return { destroy() {} }; } },
        logger: { log() {}, error() {} },
        onFatal: error => calls.failures.push(error),
        ...otherOverrides
    });
    let baseUrl;
    const originalListen = service.app.listen.bind(service.app);
    service.app.listen = (...args) => {
        const server = originalListen(...args);
        server.once('listening', () => { baseUrl = `http://127.0.0.1:${server.address().port}`; });
        return server;
    };
    return { service, calls, db, bot,
        request: async (path, init) => {
            const response = await fetch(baseUrl + path, {
                ...init, headers: { connection: 'close', ...init?.headers }
            });
            const body = await response.text();
            return { status: response.status, json: async () => JSON.parse(body) };
        },
        loseDatabase: () => { connected = false; },
        failPolling: error => rejectPolling(error)
    };
}

test('required environment is validated before connecting to Telegram', () => {
    assert.throws(() => createService({ env: {} }), /BOT_TOKEN/);
    assert.throws(() => createService({ env: { BOT_TOKEN: 'test' } }), /MONGO_URI/);
});

test('polling registers the 10h job without waiting for polling to finish', async t => {
    const f = fixture();
    t.after(() => f.service.stop());
    await f.service.start();
    assert.equal(f.calls.schedules.length, 1);
    assert.equal(f.calls.schedules[0][0], '0 10 * * *');
    assert.equal(f.calls.schedules[0][2].timezone, 'Asia/Ho_Chi_Minh');
    assert.deepEqual(await (await f.request('/health')).json(), { status: 'ok', bot: 'polling', database: 'connected' });
    f.loseDatabase();
    assert.equal((await f.request('/health')).status, 503);
});

test('enabled Muse attaches private commands and MCP while preserving the authenticated Telegram receiver', async t => {
    let initialized = false;
    const f = fixture({
        env: { MUSE_ENABLED: 'true', MUSE_ALLOWED_USER_IDS: '42', MUSE_BRIDGE_KEY: 'ab'.repeat(32), RENDER_EXTERNAL_URL: 'https://test.onrender.com' },
        museStore: { async init() { initialized = true; }, async takeDelivery() { return null; } }
    });
    t.after(() => f.service.stop());
    await f.service.start();
    assert.equal(initialized, true);
    assert.equal(typeof f.bot.context.museBridge.commands.search, 'function');
    assert.equal(f.calls.webhooks.length, 1);
    assert.equal(f.calls.schedules.length, 1);
    const health = await (await f.request('/health')).json();
    assert.equal(health.bot, 'webhook');
    assert.deepEqual(health.muse, { enabled: true, last_claim_at: null });
    assert.equal((await f.request('/muse/mcp', { method: 'POST' })).status, 401);
});

test('Render registers an authenticated webhook and rejects forged requests', async t => {
    const f = fixture({ env: { RENDER_EXTERNAL_URL: 'https://test.onrender.com' } });
    t.after(() => f.service.stop());
    await f.service.start();
    const [url, config] = f.calls.webhooks[0];
    assert.equal(url, 'https://test.onrender.com/telegram/webhook');
    assert.equal(config.secret_token.length, 64);
    assert.ok(config.allowed_updates.includes('chat_member'));
    assert.equal((await f.request('/telegram/webhook', { method: 'POST' })).status, 403);
    const response = await f.request('/telegram/webhook', {
        method: 'POST', headers: { 'content-type': 'application/json', 'x-telegram-bot-api-secret-token': config.secret_token },
        body: JSON.stringify({ update_id: 42 })
    });
    assert.equal(response.status, 200);
    assert.equal(f.calls.updates[0].update_id, 42);
    f.loseDatabase();
    assert.equal((await f.request('/telegram/webhook', {
        method: 'POST', headers: { 'x-telegram-bot-api-secret-token': config.secret_token }
    })).status, 503);
});

test('manual bulletin requires a secret and does not send twice in the same process/day', async t => {
    const f = fixture();
    t.after(() => f.service.stop());
    await f.service.start();
    assert.equal((await f.request('/cron/news')).status, 401);
    assert.equal(f.calls.sends.length, 0);
    const init = { headers: { authorization: 'Bearer test-cron-secret' } };
    assert.equal((await f.request('/cron/news', init)).status, 200);
    assert.equal((await f.request('/cron/news', init)).status, 200);
    assert.equal(f.calls.sends.length, 1);
    assert.equal(f.calls.sends[0][2].message_thread_id, 9);
});

test('a failed bulletin can be retried', async t => {
    const f = fixture();
    t.after(() => f.service.stop());
    await f.service.start();
    let failOnce = true;
    f.bot.telegram.sendMessage = async () => {
        if (failOnce) { failOnce = false; throw new Error('Telegram unavailable'); }
        f.calls.sends.push('sent');
    };
    const init = { headers: { authorization: 'Bearer test-cron-secret' } };
    assert.equal((await f.request('/cron/news', init)).status, 500);
    assert.equal((await f.request('/cron/news', init)).status, 200);
    assert.equal(f.calls.sends.length, 1);
});

test('startup fails and closes database when Telegram cannot register the webhook', async () => {
    const f = fixture({ env: { RENDER_EXTERNAL_URL: 'https://test.onrender.com' } });
    f.bot.telegram.setWebhook = async () => { throw new Error('Webhook unavailable'); };
    await assert.rejects(f.service.start(), /Webhook unavailable/);
    assert.equal(f.calls.disconnected, 1);
    assert.equal(f.calls.schedules.length, 0);
});

test('a fatal polling error makes the health check fail and is reported to the supervisor', async t => {
    const f = fixture();
    t.after(() => f.service.stop());
    await f.service.start();
    f.failPolling(new Error('409: another instance is polling'));
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(f.calls.failures.length, 1);
    assert.equal((await f.request('/health')).status, 503);
});
