function describeError(error, env = process.env) {
    let message = String(error.description || error.message || error);
    for (const key of ['BOT_TOKEN', 'MONGO_URI', 'CRON_SECRET']) {
        if (env[key]) message = message.replaceAll(env[key], '[redacted]');
    }
    return message
        .replace(/\/bot\d+:[^/\s]+/g, '/bot[redacted]')
        .replace(/mongodb(?:\+srv)?:\/\/[^\s]+/g, 'mongodb://[redacted]');
}

module.exports = { describeError };
