const { test } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StreamableHTTPClientTransport } = require('@modelcontextprotocol/sdk/client/streamableHttp.js');
const { readConfig, createMuseBridge, mountMuseMcp, resultSchema } = require('../src/muse');

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
        async countRecent(owner, since) { return [...jobs.values()].filter(j => j.owner === owner && +j.created_at >= +since).length; },
        async create(job) {
            if ([...jobs.values()].some(j => j.owner === job.owner && j.active)) throw Object.assign(new Error('duplicate'), { code: 11000 });
            jobs.set(job._id, job);
        },
        async latest(owner) { return [...jobs.values()].filter(j => j.owner === owner).at(-1); },
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
        async cancel(owner) {
            const j = [...jobs.values()].find(j => j.owner === owner && j.active);
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
    const config = readConfig({ MUSE_ENABLED: 'true', MUSE_ALLOWED_USER_IDS: '42', MUSE_BRIDGE_KEY: key });
    const bridge = createMuseBridge({ config, store, telegram, logger: { error() {} }, now: () => new Date(clock) });
    function ctx(text = '/muse iPhone 13 cũ tại TP.HCM', id = 42, type = 'private') {
        const replies = [];
        return { chat: { type }, from: { id }, message: { text }, replies,
            async reply(...args) { replies.push(args); } };
    }
    return { bridge, config, jobs, sends, store, telegram, ctx, advance: ms => { clock += ms; } };
}

test('Muse is disabled by default and enabled mode fails closed without strong key and explicit IDs', () => {
    assert.equal(readConfig({}), null);
    assert.throws(() => readConfig({ MUSE_ENABLED: 'true' }), /USER_IDS/);
    assert.throws(() => readConfig({ MUSE_ENABLED: 'true', MUSE_ALLOWED_USER_IDS: '42', MUSE_BRIDGE_KEY: 'short' }), /BRIDGE_KEY/);
    assert.equal(readConfig({ MUSE_ENABLED: 'true', MUSE_ALLOWED_USER_IDS: '42', MUSE_BRIDGE_KEY: 'ab'.repeat(16) }).key.length, 32);
    for (const invalid of ['a'.repeat(31), 'a'.repeat(33), 'g'.repeat(32)]) {
        assert.throws(() => readConfig({ MUSE_ENABLED: 'true', MUSE_ALLOWED_USER_IDS: '42', MUSE_BRIDGE_KEY: invalid }), /BRIDGE_KEY/);
    }
});

test('only allowed private users enqueue, normal data and arbitrary recipients cannot be submitted', async () => {
    const f = fixture();
    await f.bridge.commands.search(f.ctx(undefined, 99));
    await f.bridge.commands.search(f.ctx(undefined, 42, 'supergroup'));
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
