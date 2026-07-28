# Mục tiêu chạy xe

Ứng dụng quản lý mục tiêu thu nhập hàng ngày khi chạy xe, có đăng nhập và lưu dữ liệu trên server.

## Mục tiêu

**1.200.000đ / ngày**

## Cài đặt & chạy

```bash
npm install
cp .env.example .env
npm start
```

Mở trình duyệt: **http://localhost:3000**

## Tài khoản

| Vai trò | Tên đăng nhập | Mật khẩu | Quyền |
|---------|---------------|----------|--------|
| Admin | `admin` | `admin123` | Thêm / sửa / xóa / sao lưu |
| Theo dõi | `theodoi` | `xem123` | Chỉ xem doanh số |

Đổi trong file `.env`:

```
ADMIN_USERNAME=admin
ADMIN_PASSWORD=mat-khau-cua-ban
VIEWER_USERNAME=theodoi
VIEWER_PASSWORD=mat-khau-xem
JWT_SECRET=chuoi-bi-mat-dai
```

## Tính năng

- Admin quản lý dữ liệu đầy đủ
- Tài khoản theo dõi chỉ xem (không thêm/sửa)
- Lưu dữ liệu trên **SQLite**
- Menu 3 gạch: Hôm nay / Doanh số các ngày
- Nhập tiền theo nghìn (`23` = `23.000đ`)
- Tự reset mục tiêu khi qua ngày

## Công thức

```
Thực nhận = (Tiền app + Tiền ngoài + TIP) − (Điểm Zoom × 80.000) − Tiền cao tốc
Còn phải chạy = 1.200.000 − Thực nhận
```
