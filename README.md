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

1. [dashboard.render.com](https://dashboard.render.com) → **New +** → **Web Service**
2. Repo: `TranDinhHung2003/Muctieu` · Branch: `cursor/muc-tieu-chay-xe-becf`
3. Build: `npm install` · Start: `npm start` · Root Directory: **để trống**
4. Thêm Environment Variables:

| Key | Value |
|-----|--------|
| `NODE_ENV` | `production` |
| `JWT_SECRET` | chuỗi bí mật dài |
| `ADMIN_PASSWORD` | mật khẩu admin |
| `VIEWER_PASSWORD` | mật khẩu theo dõi |
| `GITHUB_TOKEN` | **bắt buộc** — Personal Access Token GitHub |
| `GITHUB_REPO` | `TranDinhHung2003/Muctieu` |
| `GITHUB_BRANCH` | `cursor/muc-tieu-chay-xe-becf` |

### Render luôn chạy (không sleep)

- `render.yaml` dùng **plan: starter** (không bị tắt như free).
- Server tự ping `/api/health` qua `RENDER_EXTERNAL_URL`.
- GitHub Action `.github/workflows/keep-render-alive.yml` ping mỗi 10 phút (có thể set secret `RENDER_HEALTH_URL` nếu URL khác).

### Thông báo đẩy khi thoát app

1. Cần `GITHUB_TOKEN` để lưu bền khóa Web Push + đăng ký máy.
2. Mỗi tài khoản mở app **một lần**, cho phép thông báo (iPhone: mở từ biểu tượng màn hình chính).
3. Sau đó tắt app vẫn nhận tin nhắn / số tiền nhập trên thanh thông báo.

## Lưu ý

- Không có `GITHUB_TOKEN` thì dữ liệu và Web Push dễ mất khi server restart
- Đổi mật khẩu ngay trên production
