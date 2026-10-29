const { test } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StreamableHTTPClientTransport } = require('@modelcontextprotocol/sdk/client/streamableHttp.js');
const { readConfig, createMongoStore, createMuseBridge, mountMuseMcp, resultSchema } = require('../src/muse');

test('real Mongoose queue model defers collection and indexes until after connection', async () => {
    const mongoose = require('mongoose');
    const { MuseJob } = require('../src/database');
    const isolated = new mongoose.Mongoose();
    isolated.set('bufferCommands', false);
    const Job = isolated.model('MuseQueueInitializationTest', MuseJob.schema.clone());
    // Defining the model while disconnected must not cache a rejected eager init.
    await Job.init();
    const calls = [];
    isolated.connection.db = {
        async createCollection(name) { calls.push(['collection', name]); return {}; },
        collection() { return { async createIndex(keys, options) { calls.push(['index', keys, options]); return 'index'; } }; }
    };
    isolated.connection.readyState = 1;
    await createMongoStore(Job).init();
    assert.equal(calls[0][0], 'collection');
    assert.equal(calls.filter(c => c[0] === 'index').length, 3);
    assert.ok(calls.some(c => c[2]?.unique && c[2]?.partialFilterExpression?.active === true));
    assert.ok(calls.some(c => c[2]?.expireAfterSeconds === 0));
});

const key = 'ab'.repeat(32);
const result = { summary: 'Đã đọc một tin rao; chưa xác minh người bán.', products: [{
    title: 'iPhone 13', url: 'https://www.facebook.com/marketplace/item/12345/',
    price: '5.000.000 ₫', location: 'TP.HCM', posted_at: '', note: ''
}] };

// A store port keeps queue tests independent of a live database or Telegram.
function fixture() {
    const jobs = new Map();
    let clock = Date.now();
    const store = {
        async init() {},
        async recover(now) {
            for (const j of jobs.values()) if (j.active && (+j.deadline <= +now ||
                (j.state === 'leased' && +j.lease_until <= +now && j.attempts >= 3))) {
                j.active = false; j.state = 'expired';
            }
        },
        async countRecent(owner, since) { return [...jobs.values()].filter(j => (!owner || j.owner === owner) && +j.created_at >= +since).length; },
        async create(job) {
            if ([...jobs.values()].some(j => j.owner === job.owner && j.active)) throw Object.assign(new Error('duplicate'), { code: 11000 });
            jobs.set(job._id, job);
        },
        async latest(owner, route) { return [...jobs.values()].filter(j => sameScope(j, owner, route)).at(-1); },
        async claim(now, token) {
            const j = [...jobs.values()].find(j => j.active && +j.deadline > +now && j.attempts < 3 &&
                (j.state === 'pending' || (j.state === 'leased' && +j.lease_until <= +now)));
            if (!j) return null;
            Object.assign(j, { state: 'leased', lease_token: token, lease_until: new Date(+now + 900000), attempts: j.attempts + 1 });
            return j;
        },
        async complete(id, token, data, now) {
            const j = jobs.get(id);
            if (!j || j.state !== 'leased' || !j.active || j.lease_token !== token || +j.lease_until <= +now || +j.deadline <= +now) return null;
            Object.assign(j, { state: 'completed', active: false, result: data, delivery: 'pending' });
            return j;
        },
        async get(id) { return jobs.get(id); },
        async cancel(owner, route) {
            const j = [...jobs.values()].find(j => sameScope(j, owner, route) && j.active);
            if (j) { j.active = false; j.state = 'cancelled'; delete j.lease_token; }
            return j;
        },
        async takeDelivery(now) {
            const j = [...jobs.values()].find(j => j.state === 'completed' && j.delivery_attempts < 3 &&
                (j.delivery === 'pending' || (j.delivery === 'sending' && +j.delivery_until <= +now)));
            if (!j) return null;
            Object.assign(j, { delivery: 'sending', delivery_until: new Date(+now + 60000), delivery_attempts: j.delivery_attempts + 1 });
            return j;
        },
        async delivered(id, success) { jobs.get(id).delivery = success ? 'sent' : 'pending'; }
    };
    const sends = [];
    const telegram = { async sendMessage(...args) { sends.push(args); } };
    const sameScope = (j, owner, route) => j.owner === owner &&
        (j.chat_id || j.owner) === route.chat_id && j.thread_id === route.thread_id;
    const config = readConfig({ MUSE_ENABLED: 'true', GROUP_CHAT_ID: '-100123', MUSE_BRIDGE_KEY: key });
    const bridge = createMuseBridge({ config, store, telegram, logger: { error() {} }, now: () => new Date(clock) });
    function ctx(text = '/muse iPhone 13 cũ tại TP.HCM', id = 42, type = 'private') {
        const replies = [];
        return { chat: { type, id: type === 'private' ? id : -100123 }, from: { id },
            message: { text, message_id: 100, ...(type === 'private' ? {} : { message_thread_id: 9 }) }, replies,
            async reply(...args) { replies.push(args); } };
    }
    return { bridge, config, jobs, sends, store, telegram, ctx, advance: ms => { clock += ms; } };
}

test('search is disabled by default and enabled mode requires a strong key and valid group ID', () => {
    assert.equal(readConfig({}), null);
    assert.throws(() => readConfig({ MUSE_ENABLED: 'true' }), /BRIDGE_KEY/);
    assert.throws(() => readConfig({ MUSE_ENABLED: 'true', MUSE_BRIDGE_KEY: key, GROUP_CHAT_ID: 'wrong' }), /GROUP_CHAT_ID/);
    assert.throws(() => readConfig({ MUSE_ENABLED: 'true', MUSE_ALLOWED_USER_IDS: '42', MUSE_BRIDGE_KEY: 'short' }), /BRIDGE_KEY/);
    assert.equal(readConfig({ MUSE_ENABLED: 'true', MUSE_ALLOWED_USER_IDS: '42', MUSE_BRIDGE_KEY: 'ab'.repeat(16) }).key.length, 32);
    for (const invalid of ['a'.repeat(31), 'a'.repeat(33), 'g'.repeat(32)]) {
        assert.throws(() => readConfig({ MUSE_ENABLED: 'true', MUSE_ALLOWED_USER_IDS: '42', MUSE_BRIDGE_KEY: invalid }), /BRIDGE_KEY/);
    }
});

test('private users and configured group topics can search; other groups, General and bots cannot', async () => {
    const f = fixture();
    const otherGroup = f.ctx(undefined, 42, 'supergroup'); otherGroup.chat.id = -100999;
    const general = f.ctx(undefined, 42, 'supergroup'); delete general.message.message_thread_id;
    const bot = f.ctx(); bot.from.is_bot = true;
    const anonymous = f.ctx(undefined, 42, 'supergroup'); anonymous.message.sender_chat = { id: -100123 };
    for (const rejected of [otherGroup, general, bot, anonymous]) await f.bridge.commands.search(rejected);
    await f.bridge.commands.search(f.ctx('/muse https://example.com'));
    assert.equal(f.jobs.size, 0);
    await f.bridge.commands.search(f.ctx());
    await f.bridge.commands.search(f.ctx());
    assert.equal(f.jobs.size, 1, 'at most one active request per owner');
    const payload = await f.bridge.claim();
    assert.equal(payload.job.query, 'iPhone 13 cũ tại TP.HCM');
    assert.equal(payload.job.max_results, 3);
    assert.ok(!JSON.stringify(payload).includes('"owner"'));
    assert.ok(!JSON.stringify(payload).includes('"chat_id"'));
    assert.deepEqual(await f.bridge.claim(), { job: null });
    assert.throws(() => resultSchema.parse({ ...result, chat_id: '-10099' }));
    assert.throws(() => resultSchema.parse({ ...result, products: [{ ...result.products[0], url: 'https://facebook.com.evil.example/123' }] }));
    await f.bridge.commands.search(f.ctx('/batam máy tính tại Hà Nội', 99));
    await f.bridge.commands.search(f.ctx('/batam@batam_2nd_bot iPhone cũ', 100, 'supergroup'));
    assert.equal(f.jobs.size, 3);
});

test('group results reply to the original message in the original topic without leaking routing to Muse', async () => {
    const f = fixture();
    const ctx = f.ctx('/batam iPhone cũ', 99, 'supergroup');
    await f.bridge.commands.search(ctx);
    assert.equal(ctx.replies[0][1].message_thread_id, 9);
    const { job } = await f.bridge.claim();
    assert.ok(!JSON.stringify(job).includes('chat_id'));
    assert.ok(!JSON.stringify(job).includes('thread_id'));
    await f.bridge.complete({ job_id: job.job_id, lease_token: job.lease_token, result });
    await f.bridge.drain();
    assert.equal(f.sends[0][0], '-100123');
    assert.equal(f.sends[0][2].message_thread_id, 9);
    assert.deepEqual(f.sends[0][2].reply_parameters, { message_id: 100, allow_sending_without_reply: true });
    const privateCtx = f.ctx('/batam_status', 99);
    await f.bridge.commands.status(privateCtx);
    assert.doesNotMatch(privateCtx.replies[0][0], /iPhone/);
    const otherTopic = f.ctx('/batam_status', 99, 'supergroup');
    otherTopic.message.message_thread_id = 2;
    await f.bridge.commands.status(otherTopic);
    assert.doesNotMatch(otherTopic.replies[0][0], /iPhone/);
});

test('Mongo status and cancel filters bind owner, chat and thread; legacy private records remain private', async () => {
    const filters = [];
    const query = { sort() { return this; }, async lean() { return null; } };
    const store = createMongoStore({
        findOne(filter) { filters.push(filter); return query; },
        findOneAndUpdate(filter) { filters.push(filter); return query; }
    });
    await store.latest('42', { chat_id: '-100123', thread_id: 9 });
    await store.cancel('42', { chat_id: '-100123', thread_id: 2 });
    assert.deepEqual(filters[0], { owner: '42', $or: [{ chat_id: '-100123', thread_id: 9 }] });
    assert.deepEqual(filters[1], { owner: '42', active: true, $or: [{ chat_id: '-100123', thread_id: 2 }] });
    await store.latest('42', { chat_id: '42' });
    assert.deepEqual(filters[2], { owner: '42', $or: [
        { chat_id: '42', thread_id: { $exists: false } }, { chat_id: { $exists: false } }
    ] });
});

test('private results and cancellation stay private even when the same user asks in a group', async () => {
    const f = fixture();
    await f.bridge.commands.search(f.ctx('tìm máy ảnh tại Huế', 99));
    const group = f.ctx('/batam_status', 99, 'supergroup');
    await f.bridge.commands.status(group);
    await f.bridge.commands.cancel(group);
    assert.equal([...f.jobs.values()][0].active, true);
    assert.doesNotMatch(JSON.stringify(group.replies), /máy ảnh/);
    const { job } = await f.bridge.claim();
    await f.bridge.complete({ job_id: job.job_id, lease_token: job.lease_token, result });
    await f.bridge.drain();
    assert.equal(f.sends[0][0], '99');
    assert.equal(f.sends[0][2].message_thread_id, undefined);
});

test('concurrent requests share a 12-per-hour cap and greetings do not consume searches', async () => {
    const f = fixture();
    const greeting = f.ctx('xin chào', 99);
    await f.bridge.commands.search(greeting);
    assert.equal(f.jobs.size, 0);
    await Promise.all(Array.from({ length: 20 }, (_, i) => f.bridge.commands.search(f.ctx('tìm iPhone tại HCM', 100 + i))));
    assert.equal(f.jobs.size, 12);
    f.advance(61 * 60000);
    await f.bridge.commands.search(f.ctx('tìm iPhone tại HCM', 999));
    assert.equal(f.jobs.size, 13);
});

test('completion binds to lease, is idempotent and delivers only to the original requester', async () => {
    const f = fixture();
    await f.bridge.commands.search(f.ctx());
    const { job } = await f.bridge.claim();
    assert.equal((await f.bridge.complete({ job_id: job.job_id, lease_token: 'ff'.repeat(24), result })).accepted, false);
    const input = { job_id: job.job_id, lease_token: job.lease_token, result };
    assert.deepEqual(await f.bridge.complete(input), { accepted: true });
    assert.deepEqual(await f.bridge.complete(input), { accepted: true, already_completed: true });
    await Promise.all([f.bridge.drain(), f.bridge.drain()]);
    await f.bridge.drain();
    assert.equal(f.sends.length, 1);
    assert.equal(f.sends[0][0], '42');
    assert.match(f.sends[0][1], /facebook\.com\/marketplace\/item\/12345/);
    assert.equal(f.sends[0][2].parse_mode, undefined);
    assert.equal(f.sends[0][2].link_preview_options.is_disabled, true);
});

test('expired leases are reclaimed and stale or cancelled results cannot deliver', async () => {
    const f = fixture();
    await f.bridge.commands.search(f.ctx());
    const first = (await f.bridge.claim()).job;
    f.advance(16 * 60000);
    const second = (await f.bridge.claim()).job;
    assert.notEqual(first.lease_token, second.lease_token);
    assert.equal((await f.bridge.complete({ job_id: first.job_id, lease_token: first.lease_token, result })).accepted, false);
    await f.bridge.commands.cancel(f.ctx());
    assert.equal((await f.bridge.complete({ job_id: second.job_id, lease_token: second.lease_token, result })).accepted, false);
    await f.bridge.drain();
    assert.equal(f.sends.length, 0);
    await f.bridge.commands.search(f.ctx());
    f.advance(61 * 60000);
    assert.deepEqual(await f.bridge.claim(), { job: null });
});

test('stored result survives delivery failure and remains available through status', async () => {
    const f = fixture();
    await f.bridge.commands.search(f.ctx());
    const { job } = await f.bridge.claim();
    await f.bridge.complete({ job_id: job.job_id, lease_token: job.lease_token, result });
    f.telegram.sendMessage = async () => { throw new Error('offline'); };
    for (let i = 0; i < 5; i++) await f.bridge.drain();
    assert.equal([...f.jobs.values()][0].delivery_attempts, 3);
    const ctx = f.ctx('/muse_status');
    await f.bridge.commands.status(ctx);
    assert.match(ctx.replies[0][0], /iPhone 13/);
});

test('real MCP HTTP client negotiates and calls only authenticated, schema-validated tools', async t => {
    const f = fixture();
    const app = express();
    mountMuseMcp(app, f.bridge, f.config, () => true);
    const server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    const url = new URL(`http://127.0.0.1:${server.address().port}/muse/mcp`);
    t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
    assert.equal((await fetch(url, { method: 'POST', body: '{}' })).status, 401);
    assert.equal((await fetch(url, { method: 'POST', headers: { authorization: `Bearer ${key}`, origin: 'https://evil.example' } })).status, 403);
    await f.bridge.commands.search(f.ctx());
    const client = new Client({ name: 'integration-test', version: '1.0.0' });
    t.after(() => client.close());
    await client.connect(new StreamableHTTPClientTransport(url, { requestInit: { headers: { authorization: `Bearer ${key}` } } }));
    const tools = await client.listTools();
    assert.deepEqual(tools.tools.map(t => t.name).sort(), ['claim_search_job', 'complete_search_job']);
    const claim = JSON.parse((await client.callTool({ name: 'claim_search_job', arguments: {} })).content[0].text);
    const bad = await client.callTool({ name: 'complete_search_job', arguments: {
        job_id: claim.job.job_id, lease_token: claim.job.lease_token, result: { ...result, chat_id: '999' }
    } });
    assert.equal(bad.isError, true);
    const complete = await client.callTool({ name: 'complete_search_job', arguments: {
        job_id: claim.job.job_id, lease_token: claim.job.lease_token, result
    } });
    assert.equal(JSON.parse(complete.content[0].text).accepted, true);
    await f.bridge.drain();
    assert.equal(f.sends.length, 1);
});
