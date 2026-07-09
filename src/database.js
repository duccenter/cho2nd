const mongoose = require('mongoose');

// Kết nối cơ sở dữ liệu
const connectDB = async () => {
    try {
        if (!process.env.MONGO_URI) {
            console.log('⚠️ CHÚ Ý: Chưa có biến môi trường MONGO_URI.');
            console.log('Bot vẫn sẽ chạy nhưng tính năng Điểm Uy Tín và Săn Đồ sẽ không lưu được dữ liệu!');
            return;
        }
        await mongoose.connect(process.env.MONGO_URI);
        console.log('✅ Đã kết nối với MongoDB thành công!');
    } catch (err) {
        console.error('❌ Lỗi kết nối MongoDB:', err);
    }
};

// Định nghĩa Cấu trúc Dữ liệu (Schema)
const UserSchema = new mongoose.Schema({
    telegram_id: { type: String, required: true, unique: true },
    username: String,
    first_name: String,
    trust_score: { type: Number, default: 0 },
    invite_count: { type: Number, default: 0 },
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

module.exports = { connectDB, User, Subscription, Scammer };
