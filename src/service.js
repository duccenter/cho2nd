const express = require('express');
const cron = require('node-cron');
const { createHmac, timingSafeEqual } = require('node:crypto');
const { describeError } = require('./errors');

const ALLOWED_UPDATES = ['message', 'callback_query', 'chat_member'];
const WEBHOOK_PATH = '/telegram/webhook';

function createService(options = {}) {
    const env = options.env || process.env;
    if (!env.BOT_TOKEN) throw new Error('Thiếu BOT_TOKEN.');
    if (!env.MONGO_URI) throw new Error('Thiếu MONGO_URI. Cần MongoDB để vận hành bot.');

    const publicUrl = env.WEBHOOK_URL || env.RENDER_EXTERNAL_URL;
    if (publicUrl && (new URL(publicUrl).protocol !== 'https:' || new URL(publicUrl).pathname !== '/')) {
        throw new Error('WEBHOOK_URL phải là URL gốc HTTPS, ví dụ https://cho2nd.onrender.com.');
    }
    if (env.NEWS_TOPIC_ID && !/^[1-9]\d*$/.test(env.NEWS_TOPIC_ID)) {
        throw new Error('NEWS_TOPIC_ID phải là số nguyên dương.');
    }

    const bot = options.bot || require('./bot');
    const db = options.db || require('./database');
    const news = options.news || require('./news');
    const scheduler = options.scheduler || cron;
    const logger = options.logger || console;
    const onFatal = options.onFatal || ((error) => logger.error(describeError(error, env)));
    const app = express();
    const secretToken = createHmac('sha256', env.BOT_TOKEN).update('cho2nd-webhook').digest('hex');
    const mode = publicUrl ? 'webhook' : 'polling';
    let ready = false;
    let stopping = false;
    let server;
    let task;
    let polling;
    let sendingNews = false;
    let lastNewsDate;

    app.disable('x-powered-by');
    const health = (_req, res) => {
        const connected = db.isConnected();
        res.status(ready && connected ? 200 : 503).json({
            status: ready && connected ? 'ok' : 'unavailable',
            bot: ready ? mode : 'stopped',
            database: connected ? 'connected' : 'disconnected'
        });
    };
    app.get('/', health);
    app.get('/health', health);

    if (publicUrl) {
        const callback = bot.webhookCallback(WEBHOOK_PATH, { secretToken });
        app.post(WEBHOOK_PATH, (req, res, next) => {
            const supplied = Buffer.from(req.get('x-telegram-bot-api-secret-token') || '');
            const expected = Buffer.from(secretToken);
            if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
                return res.sendStatus(403);
            }
            if (!ready || !db.isConnected()) return res.sendStatus(503);
            next();
        }, express.json({ limit: '1mb' }), (req, res, next) => {
            Promise.resolve(callback(req, res)).catch(next);
        });
    }

    const sendDailyNews = async () => {
        if (!ready || !db.isConnected()) return 'Dịch vụ chưa sẵn sàng.';
        if (!env.GROUP_CHAT_ID) return 'Chưa cấu hình GROUP_CHAT_ID.';
        const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Ho_Chi_Minh' });
        if (sendingNews || lastNewsDate === today) return 'Bản tin hôm nay đã gửi hoặc đang được xử lý.';
        sendingNews = true;
        try {
            const message = await news.getDailyNewsMessage();
            if (!message) return 'Không có tin tức mới trong 24h qua.';
            await bot.telegram.sendMessage(env.GROUP_CHAT_ID, message, {
                ...(env.NEWS_TOPIC_ID ? { message_thread_id: Number(env.NEWS_TOPIC_ID) } : {}),
                parse_mode: 'Markdown',
                disable_web_page_preview: false
            });
            lastNewsDate = today;
            return 'Đã gửi bản tin thành công!';
        } finally {
            sendingNews = false;
        }
    };

    const triggerNews = async (req, res, next) => {
        if (!env.CRON_SECRET) return res.status(503).send('Chưa cấu hình CRON_SECRET.');
        const supplied = Buffer.from(req.get('authorization') || '');
        const expected = Buffer.from(`Bearer ${env.CRON_SECRET}`);
        if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
            return res.sendStatus(401);
        }
        if (!ready || !db.isConnected()) return res.sendStatus(503);
        if (!env.GROUP_CHAT_ID) return res.status(503).send('Chưa cấu hình GROUP_CHAT_ID.');
        try {
            res.send(await sendDailyNews());
        } catch (error) {
            next(error);
        }
    };
    app.get('/cron/news', triggerNews);
    app.post('/cron/news', triggerNews);

    app.use((error, _req, res, _next) => {
        logger.error('Lỗi xử lý HTTP:', describeError(error, env));
        if (!res.headersSent) res.sendStatus(error.status === 400 ? 400 : 500);
        else res.end();
    });

    const stop = async () => {
        if (stopping) return;
        stopping = true;
        ready = false;
        if (task) task.destroy();
        if (mode === 'polling' && polling) {
            try { bot.stop('shutdown'); } catch (error) {
                if (error.message !== 'Bot is not running!') throw error;
            }
        }
        // Giữ webhook để Telegram có thể đánh thức Render sau khi dịch vụ ngủ.
        try {
            if (server?.listening) await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
            if (polling) await polling.catch(() => {});
        } finally {
            await db.disconnectDB();
        }
    };

    const start = async () => {
        if (server || stopping) throw new Error('Dịch vụ đã khởi động hoặc đang dừng.');
        server = app.listen(env.PORT ?? 3000, '0.0.0.0');
        await new Promise((resolve, reject) => {
            server.once('listening', resolve);
            server.once('error', reject);
        });
        server.on('error', error => { ready = false; void onFatal(error); });
        logger.log(`Web server đang chạy trên port ${server.address().port}`);
        try {
            await db.connectDB();
            if (stopping) return;
            bot.botInfo = await bot.telegram.getMe();
            if (stopping) return;
            if (publicUrl) {
                await bot.telegram.setWebhook(new URL(WEBHOOK_PATH, publicUrl).toString(), {
                    secret_token: secretToken,
                    allowed_updates: ALLOWED_UPDATES,
                    max_connections: 10
                });
            } else {
                polling = bot.launch({ allowedUpdates: ALLOWED_UPDATES });
                polling.then(() => {
                    if (!stopping) {
                        ready = false;
                        void onFatal(new Error('Telegram polling đã dừng ngoài dự kiến.'));
                    }
                }, error => {
                    if (!stopping) { ready = false; void onFatal(error); }
                });
            }
            if (stopping) return;
            ready = true;
            task = scheduler.schedule('0 10 * * *', async () => {
                try { logger.log(await sendDailyNews()); }
                catch (error) { logger.error('Lỗi gửi bản tin:', describeError(error, env)); }
            }, { timezone: 'Asia/Ho_Chi_Minh', noOverlap: true });
            logger.log(`Bot @${bot.botInfo.username} đã sẵn sàng (${mode}).`);
        } catch (error) {
            await stop();
            throw error;
        }
    };

    return { app, start, stop };
}

module.exports = { createService };
