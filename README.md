# Mục tiêu chạy xe

Ứng dụng quản lý mục tiêu thu nhập hàng ngày khi chạy xe.

## Chạy local

```bash
npm install
cp .env.example .env
npm start
```

Mở http://localhost:3000

## Tài khoản mặc định

| Vai trò | Đăng nhập | Mật khẩu |
|---------|-----------|----------|
| Admin | `admin` | `admin123` |
| Theo dõi | `theodoi` | `xem123` |

## Deploy lên Render

### Cách nhanh (Dashboard)

1. Vào [https://dashboard.render.com](https://dashboard.render.com) → **New +** → **Web Service**
2. Kết nối GitHub repo: `TranDinhHung2003/Muctieu`
3. Chọn branch `main` (hoặc `cursor/muc-tieu-chay-xe-becf` nếu chưa merge)
4. Cấu hình:
   - **Runtime:** Node
   - **Build Command:** `npm install`
   - **Start Command:** `npm start`
5. Thêm **Environment Variables**:

| Key | Value |
|-----|--------|
| `NODE_ENV` | `production` |
| `JWT_SECRET` | chuỗi bí mật dài bất kỳ |
| `ADMIN_USERNAME` | `admin` |
| `ADMIN_PASSWORD` | mật khẩu admin của bạn |
| `VIEWER_USERNAME` | `theodoi` |
| `VIEWER_PASSWORD` | mật khẩu theo dõi của bạn |
| `DATA_DIR` | `/var/data` |

6. (Khuyến nghị, gói trả phí) Thêm **Persistent Disk**:
   - Mount path: `/var/data`
   - Size: 1 GB
   - Thêm env `DATA_DIR=/var/data`  
   → Giữ dữ liệu SQLite khi redeploy. **Gói Free không có disk** — dữ liệu có thể mất khi service sleep/redeploy; dùng nút **Sao lưu** thường xuyên.

7. Bấm **Create Web Service** → chờ build xong → mở URL dạng `https://xxx.onrender.com`

### Blueprint (render.yaml)

Repo đã có `render.yaml`. Có thể dùng **New + → Blueprint** và chọn repo này.

## Lưu ý trên Render Free

- Service sleep khi không dùng (~15 phút). Lần mở đầu có thể chậm.
- Không gắn Persistent Disk thì dữ liệu SQLite có thể mất khi redeploy.
- Đổi `ADMIN_PASSWORD` / `VIEWER_PASSWORD` ngay sau khi lên production.
