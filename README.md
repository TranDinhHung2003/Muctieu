# Mục tiêu chạy xe

Ứng dụng quản lý mục tiêu thu nhập hàng ngày khi chạy xe, có đăng nhập admin và lưu dữ liệu trên server.

## Mục tiêu

**1.200.000đ / ngày**

## Cài đặt & chạy

```bash
npm install
cp .env.example .env
npm start
```

Mở trình duyệt: **http://localhost:3000**

## Đăng nhập Admin

| | |
|---|---|
| Tên đăng nhập | `admin` |
| Mật khẩu | `admin123` |

> Đổi mật khẩu ngay sau lần đăng nhập đầu tiên (nút **Đổi MK** trên giao diện).

Có thể thay đổi tài khoản mặc định trong file `.env`:

```
ADMIN_USERNAME=admin
ADMIN_PASSWORD=mat-khau-cua-ban
JWT_SECRET=chuoi-bi-mat-dai
```

## Tính năng

- Đăng nhập admin bảo vệ dữ liệu
- Lưu dữ liệu trên **SQLite** (không mất khi xóa cache trình duyệt)
- Tự động sao lưu file `data/backup-latest.json`
- Xuất file sao lưu JSON (nút **Sao lưu**)
- Nhập dữ liệu cũ từ localStorage lên server (lần đăng nhập đầu)
- Thống kê doanh thu ngày / tuần / tháng
- Cộng dồn từng lượt: app, ngoài, Zoom, cao tốc, TIP
- Xem lại doanh số các ngày

## Công thức

```
Thực nhận = (Tiền app + Tiền ngoài + TIP) − (Điểm Zoom × 80.000) − Tiền cao tốc
Còn phải chạy = 1.200.000 − Thực nhận
```

## Cấu trúc dữ liệu

- `data/muctieu.db` — cơ sở dữ liệu chính
- `data/backup-latest.json` — bản sao lưu tự động mỗi khi lưu

**Lưu ý:** Sao chép thư mục `data/` định kỳ để phòng trường hợp mất máy chủ.
