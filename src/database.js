const mongoose = require('mongoose');
mongoose.set('bufferCommands', false);

// Kết nối cơ sở dữ liệu
const connectDB = async () => {
    if (!process.env.MONGO_URI) throw new Error('Chưa cấu hình MONGO_URI.');
    await mongoose.connect(process.env.MONGO_URI, { serverSelectionTimeoutMS: 15000 });
    console.log('✅ Đã kết nối với MongoDB thành công!');
};

// Định nghĩa Cấu trúc Dữ liệu (Schema)
const UserSchema = new mongoose.Schema({
    telegram_id: { type: String, required: true, unique: true },
    username: String,
    first_name: String,
    trust_score: { type: Number, default: 0 },
    invite_count: { type: Number, default: 0 },
    post_builder_state: { type: String, default: 'none' },
    post_draft: { type: Object, default: {} },
    joined_at: { type: Date, default: Date.now },
    last_posted_at: { type: Date, default: 0 } // Dùng cho Anti-Flood
});

const SubscriptionSchema = new mongoose.Schema({
    telegram_id: { type: String, required: true },
    keyword: { type: String, required: true },
    created_at: { type: Date, default: Date.now }
});

const ScammerSchema = new mongoose.Schema({
    target: { type: String, required: true, unique: true }, // Số điện thoại hoặc username
    reason: { type: String, default: "Lừa đảo" },
    added_by: { type: String },
    created_at: { type: Date, default: Date.now }
});

// Tạo Model
const User = mongoose.model('User', UserSchema);
const Subscription = mongoose.model('Subscription', SubscriptionSchema);
const Scammer = mongoose.model('Scammer', ScammerSchema);

// Keep routing data on Batam; the MCP tools expose only an opaque job and query.
const MuseJobSchema = new mongoose.Schema({
    _id: { type: String, required: true },
    owner: { type: String, required: true },
    chat_id: String,
    thread_id: Number,
    reply_to_message_id: Number,
    request_key: String,
    query: { type: String, required: true, maxlength: 2000 },
    active: { type: Boolean, required: true },
    state: { type: String, enum: ['pending', 'leased', 'completed', 'cancelled', 'expired'], required: true },
    attempts: { type: Number, default: 0 },
    lease_token: String,
    lease_until: Date,
    result: mongoose.Schema.Types.Mixed,
    delivery: { type: String, enum: ['pending', 'sending', 'sent'] },
    delivery_attempts: { type: Number, default: 0 },
    delivery_until: Date,
    created_at: { type: Date, required: true },
    deadline: { type: Date, required: true },
    expires_at: { type: Date, required: true }
}, { autoCreate: false, autoIndex: false });
MuseJobSchema.index({ owner: 1 }, { unique: true, partialFilterExpression: { active: true } });
MuseJobSchema.index({ expires_at: 1 }, { expireAfterSeconds: 0 });
MuseJobSchema.index({ state: 1, active: 1, created_at: 1 });
MuseJobSchema.index({ request_key: 1 }, { unique: true, partialFilterExpression: { request_key: { $type: 'string' } } });
const MuseJob = mongoose.model('MuseJob', MuseJobSchema);

const isConnected = () => mongoose.connection.readyState === 1;
const disconnectDB = () => mongoose.disconnect();

module.exports = { connectDB, disconnectDB, isConnected, User, Subscription, Scammer, MuseJob };
