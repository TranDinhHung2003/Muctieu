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

### Tạo GITHUB_TOKEN (quan trọng)

Để `theodoi` vẫn xem được số tiền khi admin đã thoát / Render sleep:

1. GitHub → **Settings** → **Developer settings** → **Personal access tokens**
2. Tạo token (fine-grained hoặc classic) với quyền **Contents: Read and write** cho repo `Muctieu`
3. Dán vào Render env `GITHUB_TOKEN`

Khi admin thêm tiền → lưu lên GitHub. Khi server khởi động lại → tự tải về. Tài khoản theo dõi chỉ cần đăng nhập `theodoi` là thấy.

## Lưu ý

- Render Free: lần mở đầu sau sleep có thể chậm ~30–50 giây
- Không có `GITHUB_TOKEN` thì dữ liệu dễ mất khi server sleep
- Đổi mật khẩu ngay trên production
