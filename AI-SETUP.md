# Cấu hình gia sư AI

Trang lab gọi máy chủ cùng nguồn tại `/api/tutor`. Máy chủ gửi yêu cầu tới OpenAI Responses API; khóa chỉ nằm ở biến môi trường trên máy chủ.

## Chạy trên máy chủ Node

1. Dùng Node.js 18 trở lên.
2. Đặt biến bí mật `OPENAI_API_KEY` trong mục Environment Variables / Secrets của nền tảng lưu trữ.
3. Có thể đặt `OPENAI_MODEL` thành model mà dự án API của bạn được phép dùng. Mặc định là `gpt-6-astra`.
4. Khởi động bằng `npm start`. Máy chủ phục vụ trang tại `/` và API gia sư tại `/api/tutor`.
5. Mở `/api/health`; trường `aiAvailable` cho biết máy chủ đã nhận cấu hình khóa hay chưa.

Không đưa khóa vào `index.html`, JavaScript phía trình duyệt, GitHub Actions log, hoặc file `.env` đã commit. API có giới hạn 18 yêu cầu mỗi phút trên mỗi IP, 8 tin nhắn ngữ cảnh và 450 token đầu ra.

## Lưu ý triển khai

GitHub Pages chỉ phục vụ tệp tĩnh và không chạy `server.mjs`. Hãy triển khai ứng dụng trên dịch vụ hỗ trợ Node.js, nơi trang và API có thể dùng chung một origin. Nếu vẫn host trang trên GitHub Pages, cần một backend riêng và cấu hình cùng-origin/reverse proxy cho `/api`; không gọi OpenAI trực tiếp từ trình duyệt.

Nếu chưa cấu hình khóa, trang vẫn dùng lời giải thích dự phòng cơ bản. Câu trả lời AI thật chỉ hoạt động sau khi cấu hình khóa API ở máy chủ.

