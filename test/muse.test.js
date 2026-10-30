const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const express = require('express');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StreamableHTTPClientTransport } = require('@modelcontextprotocol/sdk/client/streamableHttp.js');
const { readConfig, createMongoStore, createMuseBridge, mountMuseMcp, resultSchema, formatResult } = require('../src/muse');

test('real Mongoose queue model defers collection and indexes until after connection', async () => {
    const mongoose = require('mongoose');
    const { MuseJob, MuseThread } = require('../src/database');
    const isolated = new mongoose.Mongoose();
    isolated.set('bufferCommands', false);
    const Job = isolated.model('MuseQueueInitializationTest', MuseJob.schema.clone());
    const Thread = isolated.model('MuseThreadInitializationTest', MuseThread.schema.clone());
    // Defining the model while disconnected must not cache a rejected eager init.
    await Job.init();
    await Thread.init();
    const calls = [];
    isolated.connection.db = {
        async createCollection(name) { calls.push(['collection', name]); return {}; },
        collection() { return { async createIndex(keys, options) { calls.push(['index', keys, options]); return 'index'; } }; }
    };
    isolated.connection.readyState = 1;
    await createMongoStore(Job, Thread).init();
    assert.equal(calls[0][0], 'collection');
    assert.equal(calls.filter(c => c[0] === 'collection').length, 2);
    assert.equal(calls.filter(c => c[0] === 'index').length, 5);
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
    const threads = new Map();
    let clock = Date.now();
    let messageId = 99;
    const store = {
        async init() {},
        async resetThread(key, now) {
            const thread = { session_id: randomUUID(), sequence: 0, remembered_sequence: 0, turns: [],
                expires_at: new Date(+now + 30 * 86400000) };
            threads.set(key, thread);
            return thread;
        },
        async getThread(key, now) {
            let thread = threads.get(key);
            if (!thread || +thread.expires_at <= +now) thread = await store.resetThread(key, now);
            thread.sequence++;
            thread.expires_at = new Date(+now + 30 * 86400000);
            return thread;
        },
        async remember(job, now) {
            const thread = threads.get(job.conversation_key);
            if (!thread || thread.session_id !== job.conversation_id || +thread.expires_at <= +now ||
                thread.remembered_sequence >= job.conversation_sequence) return;
            thread.turns.push({ job_id: job._id, user: job.query, assistant: formatResult(job.result), at: now });
            thread.turns = thread.turns.slice(-50);
            thread.remembered_sequence = job.conversation_sequence;
            thread.expires_at = new Date(+now + 30 * 86400000);
        },
        async recover(now) {
            for (const j of jobs.values()) if (j.active && (+j.deadline <= +now ||
                (j.state === 'leased' && +j.lease_until <= +now && j.attempts >= 3))) {
                j.active = false; j.state = 'expired'; j.delivery = 'pending';
            }
        },
        async byRequest(requestKey) { return [...jobs.values()].find(j => j.request_key === requestKey); },
        async create(job) {
            if ([...jobs.values()].some(j => (j.owner === job.owner && j.active) || (job.request_key && j.request_key === job.request_key))) throw Object.assign(new Error('duplicate'), { code: 11000 });
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
            const j = [...jobs.values()].find(j => ['completed', 'expired'].includes(j.state) && j.delivery_attempts < 3 &&
                ((j.delivery === 'pending' && (!j.delivery_until || +j.delivery_until <= +now)) || (j.delivery === 'sending' && +j.delivery_until <= +now)));
            if (!j) return null;
            Object.assign(j, { delivery: 'sending', delivery_until: new Date(+now + 60000), delivery_attempts: j.delivery_attempts + 1 });
            return j;
        },
        async delivered(id, success, retryAt) {
            const job = jobs.get(id);
            job.delivery = success ? 'sent' : 'pending';
            if (retryAt) job.delivery_until = retryAt;
        }
    };
    const sends = [];
    const telegram = { async sendMessage(...args) { sends.push(args); } };
    const sameScope = (j, owner, route) => j.owner === owner &&
        (j.chat_id || j.owner) === route.chat_id && j.thread_id === route.thread_id;
    const config = readConfig({ MUSE_ENABLED: 'true', GROUP_CHAT_ID: '-100123', MUSE_BRIDGE_KEY: key });
    const restart = () => createMuseBridge({ config, store, telegram, logger: { error() {} }, now: () => new Date(clock) });
    const bridge = restart();
    function ctx(text = '/muse iPhone 13 cũ tại TP.HCM', id = 42, type = 'private') {
        const replies = [];
        return { chat: { type, id: type === 'private' ? id : -100123 }, from: { id },
            message: { text, message_id: messageId++, ...(type === 'private' ? {} : { message_thread_id: 9 }) }, replies,
            async reply(...args) { replies.push(args); } };
    }
    return { bridge, restart, config, jobs, threads, sends, store, telegram, ctx, advance: ms => { clock += ms; } };
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
    await f.bridge.commands.search(f.ctx('/muse https://localhost/admin'));
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
    assert.equal(ctx.replies.length, 0);
    const { job } = await f.bridge.claim();
    assert.ok(!JSON.stringify(job).includes('chat_id'));
    assert.ok(!JSON.stringify(job).includes('thread_id'));
    await f.bridge.complete({ job_id: job.job_id, lease_token: job.lease_token, result });
    await f.bridge.drain();
    assert.equal(f.sends[0][0], '-100123');
    assert.equal(f.sends[0][2].message_thread_id, 9);
    assert.deepEqual(f.sends[0][2].reply_parameters, { message_id: ctx.message.message_id, allow_sending_without_reply: true });
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

test('everyone can enqueue beyond 12 per hour and greetings do not consume searches', async () => {
    const f = fixture();
    const greeting = f.ctx('xin chào', 99);
    await f.bridge.commands.search(greeting);
    assert.equal(f.jobs.size, 0);
    await Promise.all(Array.from({ length: 20 }, (_, i) => f.bridge.commands.search(f.ctx('tìm iPhone tại HCM', 100 + i))));
    assert.equal(f.jobs.size, 20);
    // One person can search again as soon as their previous job completes,
    // even after more than 12 completed searches in the same hour.
    for (let i = 0; i < 15; i++) {
        await f.bridge.commands.search(f.ctx('tìm máy ảnh tại Huế', 999));
        const pending = [...f.jobs.values()].find(j => j.owner === '999' && j.active);
        pending.state = 'completed'; pending.active = false;
    }
    assert.equal(f.jobs.size, 35);
});

test('Telegram redelivery is idempotent even after the original result was completed', async () => {
    const f = fixture();
    const ctx = f.ctx('tìm máy ảnh tại Huế');
    await f.bridge.commands.search(ctx);
    const { job } = await f.bridge.claim();
    await f.bridge.complete({ job_id: job.job_id, lease_token: job.lease_token, result });
    await f.bridge.commands.search(ctx);
    assert.equal(f.jobs.size, 1);
    assert.match(ctx.replies.at(-1)[0], /nhận tin nhắn này trước đó/);
});

test('multiline detailed requests fit within 2000 characters and invalid lengths are rejected', async () => {
    const f = fixture();
    const query = 'tìm iPhone 13\nTP.HCM\tdưới 6 triệu ' + 'cấu hình '.repeat(20);
    await f.bridge.commands.search(f.ctx(query));
    const job = [...f.jobs.values()][0];
    assert.ok(job.query.length > 180);
    assert.doesNotMatch(job.query, /[\n\t]/);
    await f.bridge.commands.search(f.ctx('a'.repeat(2001), 99));
    assert.equal(f.jobs.size, 1);
});

test('general questions, writing and public HTTPS references reach the worker without account context', async () => {
    const f = fixture();
    const question = 'Giải thích cơ chế event loop của Node.js theo https://nodejs.org/en/learn/ với ví dụ dễ hiểu. ' + 'Chi tiết '.repeat(90);
    await f.bridge.commands.search(f.ctx(question));
    const { job } = await f.bridge.claim();
    assert.equal(job.query, question.trim());
    assert.ok(job.query.length > 600);
    assert.equal(job.source, 'public_web_or_knowledge');
    assert.ok(job.result_formats.includes('answer_sources'));
    assert.match(job.instruction, /writing, translation/);
    assert.ok(!JSON.stringify(job).includes('chat_id'));
    assert.ok(!JSON.stringify(job).includes('owner'));
});

test('general answers with sources deliver in the original topic, remain scoped and support status', async () => {
    const f = fixture();
    const ctx = f.ctx('Giải thích event loop', 42, 'supergroup');
    await f.bridge.commands.search(ctx);
    const { job } = await f.bridge.claim();
    const answer = { answer: 'Event loop giúp Node.js xử lý tác vụ bất đồng bộ.', sources: [{ title: 'Node.js', url: 'https://nodejs.org/en/learn/' }] };
    await f.bridge.complete({ job_id: job.job_id, lease_token: job.lease_token, result: answer });
    await f.bridge.drain();
    assert.equal(f.sends[0][0], '-100123');
    assert.equal(f.sends[0][2].message_thread_id, 9);
    assert.equal(f.sends[0][2].reply_parameters.message_id, ctx.message.message_id);
    assert.match(f.sends[0][1], /Batam trả lời/);
    assert.match(f.sends[0][1], /nodejs.org/);
    assert.doesNotMatch(f.sends[0][1], /Marketplace|Giá:/);
    const status = f.ctx('/batam_status', 42, 'supergroup');
    await f.bridge.commands.status(status);
    assert.match(status.replies[0][0], /Event loop/);
    const privateStatus = f.ctx('/batam_status');
    await f.bridge.commands.status(privateStatus);
    assert.doesNotMatch(privateStatus.replies[0][0], /Event loop/);
});

test('general result schema rejects oversized answers, recipient fields and unsafe sources; maximum result fits Telegram', () => {
    const answer = { answer: 'Thông tin chung', sources: [] };
    assert.deepEqual(resultSchema.parse(answer), answer);
    for (const url of ['javascript:alert(1)', 'file:///etc/passwd', 'http://nodejs.org', 'https://user:pass@nodejs.org/',
        'https://127.0.0.1/', 'https://2130706433/', 'https://[::1]/', 'https://localhost/', 'https://localhost./',
        'https://app.internal/', 'https://router.lan/', 'https://nodejs.org:8443/']) {
        assert.throws(() => resultSchema.parse({ ...answer, sources: [{ title: 'Nguồn', url }] }), url);
    }
    assert.throws(() => resultSchema.parse({ ...answer, chat_id: '999' }));
    assert.throws(() => resultSchema.parse({ ...answer, answer: 'a'.repeat(2501) }));
    assert.throws(() => resultSchema.parse({ ...answer, products: [] }));
    const max = resultSchema.parse({ answer: 'a'.repeat(2500), sources: Array.from({ length: 3 }, () => ({
        title: 't'.repeat(100), url: 'https://nodejs.org/' + 'p'.repeat(300 - 'https://nodejs.org/'.length)
    })) });
    assert.ok(formatResult(max).length < 4096);
});

test('private or credential-bearing request URLs are rejected before queuing', async () => {
    const f = fixture();
    for (const url of ['http://nodejs.org/', 'https://user:pass@nodejs.org/', 'https://127.0.0.1/', 'https://service.internal/']) {
        await f.bridge.commands.search(f.ctx('Đọc ' + url));
    }
    assert.equal(f.jobs.size, 0);
});

test('multiple workers claim different jobs and expired requests notify their original chat', async () => {
    const f = fixture();
    for (let i = 0; i < 5; i++) await f.bridge.commands.search(f.ctx('tìm iPhone tại Huế', 100 + i));
    const jobs = await Promise.all(Array.from({ length: 5 }, () => f.bridge.claim()));
    assert.equal(new Set(jobs.map(j => j.job.job_id)).size, 5);
    f.advance(61 * 60000);
    assert.deepEqual(await f.bridge.claim(), { job: null });
    for (let i = 0; i < 5; i++) await f.bridge.drain();
    assert.equal(f.sends.length, 5);
    assert.match(f.sends[0][1], /hết thời gian chờ/);
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
    for (let i = 0; i < 5; i++) { await f.bridge.drain(); f.advance(5 * 60000); }
    assert.equal([...f.jobs.values()][0].delivery_attempts, 3);
    const ctx = f.ctx('/muse_status');
    await f.bridge.commands.status(ctx);
    assert.match(ctx.replies[0][0], /iPhone 13/);
});

test('Telegram retry_after is respected and completion/delivery health track actual progress', async () => {
    const f = fixture();
    await f.bridge.commands.search(f.ctx());
    const { job } = await f.bridge.claim();
    await f.bridge.complete({ job_id: job.job_id, lease_token: job.lease_token, result });
    assert.ok(f.bridge.health().last_completed_at);
    assert.equal(f.bridge.health().last_delivered_at, null);
    let attempts = 0;
    f.telegram.sendMessage = async () => {
        if (++attempts === 1) throw { response: { parameters: { retry_after: 60 } } };
    };
    await f.bridge.drain();
    await f.bridge.drain();
    f.advance(59000); await f.bridge.drain();
    assert.equal(attempts, 1);
    f.advance(1000); await f.bridge.drain();
    assert.equal(attempts, 2);
    assert.ok(f.bridge.health().last_delivered_at);
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
    await f.bridge.commands.search(f.ctx('Dịch câu xin chào sang tiếng Anh', 99));
    const general = JSON.parse((await client.callTool({ name: 'claim_search_job', arguments: {} })).content[0].text);
    const answer = await client.callTool({ name: 'complete_search_job', arguments: {
        job_id: general.job.job_id, lease_token: general.job.lease_token, result: { answer: 'Hello.', sources: [] }
    } });
    assert.equal(JSON.parse(answer.content[0].text).accepted, true);
    await f.bridge.drain();
    assert.equal(f.sends[1][0], '99');
    assert.match(f.sends[1][1], /Hello/);
    await f.bridge.commands.search(f.ctx('Còn tin rao lúc nãy?'));
    const followup = JSON.parse((await client.callTool({ name: 'claim_search_job', arguments: {} })).content[0].text);
    assert.equal(followup.job.history.length, 1);
    assert.match(followup.job.history[0].assistant, /iPhone 13/);
    assert.equal(Object.hasOwn(followup.job.history[0], 'job_id'), false);
});

async function exchange(f, ctx, answer = 'Đã ghi nhận.') {
    await f.bridge.commands.search(ctx);
    const { job } = await f.bridge.claim();
    assert.ok(job);
    await f.bridge.complete({ job_id: job.job_id, lease_token: job.lease_token, result: { answer, sources: [] } });
    await f.bridge.drain();
    return job;
}

test('conversation survives three days, process restart and removal of the 24-hour queue', async () => {
    const f = fixture();
    await exchange(f, f.ctx('Ngân sách 7 triệu, ưu tiên gọn nhẹ.'), 'Bạn cần laptop gọn nhẹ trong 7 triệu.');
    f.advance(3 * 86400000);
    f.jobs.clear();
    f.bridge = f.restart();
    await f.bridge.commands.search(f.ctx('Ngân sách tôi nói là bao nhiêu?'));
    const { job } = await f.bridge.claim();
    assert.equal(job.history.length, 1);
    assert.equal(job.history[0].user, 'Ngân sách 7 triệu, ưu tiên gọn nhẹ.');
    assert.match(job.history[0].assistant, /7 triệu/);
    assert.equal(Date.now() - Date.parse(job.history[0].at) < 10000, true);
    for (const field of ['owner', 'chat_id', 'thread_id', 'conversation_key', 'conversation_id', 'conversation_sequence']) {
        assert.equal(Object.hasOwn(job, field), false);
    }
});

test('history isolates people, private chats and each group topic', async () => {
    const f = fixture();
    await exchange(f, f.ctx('Ghi nhớ sở thích riêng của A.'), 'Sở thích A.');
    const groupA = f.ctx('Ngữ cảnh nhóm A.', 42, 'supergroup');
    assert.deepEqual((await exchange(f, groupA)).history, []);
    const topicB = f.ctx('Topic khác.', 42, 'supergroup'); topicB.message.message_thread_id = 10;
    assert.deepEqual((await exchange(f, topicB)).history, []);
    assert.deepEqual((await exchange(f, f.ctx('Người khác hỏi.', 99))).history, []);
    const back = await exchange(f, f.ctx('Tiếp tục nhóm A.', 42, 'supergroup'));
    assert.deepEqual(back.history.map(t => t.user), ['Ngữ cảnh nhóm A.']);
    const privateA = await exchange(f, f.ctx('Tiếp tục riêng A.'));
    assert.deepEqual(privateA.history.map(t => t.user), ['Ghi nhớ sở thích riêng của A.']);
});

test('reset changes only current scope and a late completion cannot repopulate the old generation', async () => {
    const f = fixture();
    await exchange(f, f.ctx('Ngữ cảnh riêng.'));
    await exchange(f, f.ctx('Ngữ cảnh nhóm.', 42, 'supergroup'));
    await f.bridge.commands.search(f.ctx('Yêu cầu riêng còn đang xử lý.'));
    const { job } = await f.bridge.claim();
    await f.bridge.commands.newThread(f.ctx('/batam_new'));
    await f.bridge.complete({ job_id: job.job_id, lease_token: job.lease_token, result: { answer: 'Kết quả cũ.', sources: [] } });
    await f.bridge.drain();
    assert.equal(f.sends.length, 3, 'late result still replies to its original query');
    assert.deepEqual((await exchange(f, f.ctx('Câu hỏi mới.'))).history, []);
    const group = await exchange(f, f.ctx('Câu hỏi nhóm tiếp.', 42, 'supergroup'));
    assert.deepEqual(group.history.map(t => t.user), ['Ngữ cảnh nhóm.']);
});

test('30-day expiry is enforced even before Mongo TTL has deleted the document', async () => {
    const f = fixture();
    await exchange(f, f.ctx('Thông tin cũ.'));
    const oldId = [...f.threads.values()][0].session_id;
    f.advance(31 * 86400000);
    f.jobs.clear();
    assert.deepEqual((await exchange(f, f.ctx('Tôi quay lại.'))).history, []);
    assert.notEqual([...f.threads.values()][0].session_id, oldId);
});

test('history is bounded and replaying an evicted completion never re-adds it', async () => {
    const f = fixture();
    const first = await exchange(f, f.ctx('Lượt 0'));
    for (let i = 1; i <= 55; i++) await exchange(f, f.ctx(`Lượt ${i}`), `Trả lời ${i}`);
    const thread = [...f.threads.values()][0];
    assert.equal(thread.turns.length, 50);
    const retained = await exchange(f, f.ctx('Nhắc lại các lượt trước.'));
    assert.equal(retained.history.length, 50);
    assert.equal(retained.history[0].user, 'Lượt 6');
    assert.equal(retained.history.at(-1).user, 'Lượt 55');
    const before = structuredClone(thread.turns);
    await f.bridge.complete({ job_id: first.job_id, lease_token: first.lease_token, result });
    assert.deepEqual(thread.turns, before);
    for (let i = 0; i < 50; i++) await exchange(f, f.ctx('u'.repeat(2000)), 'a'.repeat(2500));
    const bounded = await exchange(f, f.ctx('Tiếp theo'));
    assert.ok(bounded.history.length >= 20 && bounded.history.length < 50);
    assert.ok(bounded.history.reduce((n, t) => n + t.user.length + t.assistant.length, 0) <= 100000);
    assert.equal(thread.turns.length, 50);
});

test('database context failures fail closed; completion memory retry is idempotent', async () => {
    const f = fixture();
    const getThread = f.store.getThread;
    f.store.getThread = async () => { throw new Error('offline'); };
    const ctx = f.ctx('Câu hỏi.');
    await f.bridge.commands.search(ctx);
    assert.equal(f.jobs.size, 0);
    assert.match(ctx.replies[0][0], /Chưa đọc được ngữ cảnh/);
    f.store.getThread = getThread;
    await f.bridge.commands.search(f.ctx('Hỏi lại.'));
    const { job } = await f.bridge.claim();
    const remember = f.store.remember;
    f.store.remember = async () => { throw new Error('offline'); };
    const completion = { job_id: job.job_id, lease_token: job.lease_token, result: { answer: 'Trả lời.', sources: [] } };
    await assert.rejects(f.bridge.complete(completion), /offline/);
    f.store.remember = remember;
    assert.equal((await f.bridge.complete(completion)).already_completed, true);
    await f.bridge.drain();
    assert.equal([...f.threads.values()][0].turns.length, 1);
    assert.equal(f.sends.length, 1);
});

test('legacy queue jobs without conversation metadata still deliver', async () => {
    const f = fixture();
    await f.bridge.commands.search(f.ctx());
    const raw = [...f.jobs.values()][0];
    delete raw.conversation_key; delete raw.conversation_id; delete raw.history;
    const { job } = await f.bridge.claim();
    assert.deepEqual(job.history, []);
    await f.bridge.complete({ job_id: job.job_id, lease_token: job.lease_token, result });
    await f.bridge.drain();
    assert.equal(f.sends.length, 1);
});

test('Mongo memory update rejects earlier sequences even after history eviction and requires current generation', async () => {
    let captured;
    const store = createMongoStore({}, { updateOne: async (filter, update) => { captured = { filter, update }; } });
    const now = new Date();
    await store.remember({ _id: 'job', conversation_key: 'scope', conversation_id: 'generation',
        conversation_sequence: 12, query: 'Question', result: { answer: 'Answer', sources: [] } }, now);
    assert.deepEqual(captured.filter, { _id: 'scope', session_id: 'generation', expires_at: { $gt: now },
        remembered_sequence: { $lt: 12 } });
    assert.equal(captured.update.$set.remembered_sequence, 12);
    assert.equal(captured.update.$push.turns.$slice, -50);
});
