require('dotenv').config();
const { createService } = require('./src/service');
const { describeError } = require('./src/errors');

if (require.main === module) {
    let service;
    let stopping = false;

    const shutdown = async (exitCode) => {
        if (stopping) return;
        stopping = true;
        const timeout = setTimeout(() => process.exit(1), 10000);
        timeout.unref();
        try {
            if (service) await service.stop();
        } catch (error) {
            console.error('Lỗi khi dừng dịch vụ:', describeError(error));
            exitCode = 1;
        } finally {
            clearTimeout(timeout);
            process.exitCode = exitCode;
        }
    };

    const fail = async (error) => {
        console.error('Dịch vụ đã dừng:', describeError(error));
        await shutdown(1);
    };

    process.once('SIGINT', () => { void shutdown(0); });
    process.once('SIGTERM', () => { void shutdown(0); });

    try {
        service = createService({ onFatal: fail });
        service.start().catch(fail);
    } catch (error) {
        void fail(error);
    }
}

module.exports = { createService };
