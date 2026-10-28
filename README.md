# Bot Chợ 2nd

Bot Telegram quản lý nhóm mua bán, dùng MongoDB Atlas và Node.js 22.

## Triển khai trên Render

1. Khôi phục cluster MongoDB nếu Atlas báo `PAUSED`. Giữ nguyên gói Free.
2. Tạo Web Service từ kho `duccenter/cho2nd`, nhánh `main`, runtime Node.
3. Chọn gói Free, build `npm ci`, start `npm start`, health check `/health`.
4. Cấu hình các biến môi trường bên dưới. Không đưa token hoặc URI thật lên GitHub.
5. Deploy và kiểm tra `/health` trả HTTP 200 với `bot: "webhook"`, `database: "connected"`.

Có thể dùng Blueprint `render.yaml` để điền sẵn cấu hình dịch vụ.

| Biến | Ý nghĩa |
| --- | --- |
| `BOT_TOKEN` | Token bot do BotFather cấp; bắt buộc. |
| `MONGO_URI` | URI MongoDB có tên database, ví dụ `cho2nd`; bắt buộc. |
| `GROUP_CHAT_ID` | ID nhóm đích, thường bắt đầu bằng `-100`. |
| `MUABAN_TOPIC_IDS` | Danh sách ID topic mua bán, ngăn cách bằng dấu phẩy. |
| `NEWS_TOPIC_ID` | Topic nhận bản tin; để trống để gửi vào sảnh chung. |
| `CRON_SECRET` | Chuỗi bí mật bảo vệ API gửi bản tin. |
| `NODE_VERSION` | `22` trên Render. |
| `WEBHOOK_URL` | URL gốc HTTPS nếu chạy ngoài Render; trên Render để trống. |

Render tự cấp `PORT` và `RENDER_EXTERNAL_URL`. Bot tự đăng ký webhook có xác thực,
không chạy polling trên Render. Chỉ chạy một dịch vụ cho cùng một token.
MongoDB Atlas phải cho phép kết nối từ các outbound IP của dịch vụ Render;
chỉ thêm các dải IP cần thiết, không tự mở truy cập toàn Internet.

Gói Render Free có thể ngủ khi không có truy cập. Telegram sẽ đánh thức dịch vụ
bằng webhook, nhưng phản hồi đầu tiên có thể chậm trong lúc khởi động lại.
Cron trong tiến trình chỉ chạy khi dịch vụ đang thức. Để gửi tin đúng 10h,
cấu hình bộ lập lịch bên ngoài gọi `GET /cron/news` với header
`Authorization: Bearer <CRON_SECRET>` lúc 10:00, múi giờ `Asia/Ho_Chi_Minh`.
API chặn gửi chồng và gửi lại trong cùng ngày khi tiến trình còn chạy;
trạng thái này không được lưu qua lần khởi động lại.

## Chạy trên máy cá nhân

Sao chép `.env.example` thành `.env`, điền cấu hình rồi chạy:

```sh
npm ci
npm test
npm start
```

Không đặt `WEBHOOK_URL` hoặc `RENDER_EXTERNAL_URL` khi chạy local bằng polling.
Không chạy bản local đồng thời với dịch vụ Render dùng cùng token.
Khi thiếu cấu hình hoặc không kết nối được database, dịch vụ báo lỗi và thoát
để máy chủ có thể phát hiện và khởi động lại.
