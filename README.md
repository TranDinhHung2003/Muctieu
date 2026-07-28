# Chạy Đủ

Trang web theo dõi mục tiêu doanh thu ngày khi chạy xe.

**Mục tiêu ngày:** 1.200.000đ

## Đăng nhập & lưu dữ liệu

1. **Tạo tài khoản** bằng số điện thoại + mã PIN (4–6 số)
2. Nhập số liệu trong ngày — hệ thống **tự lưu** ngay trên máy
3. **Đăng xuất** chỉ thoát phiên, **không xóa** dữ liệu
4. **Đăng nhập lại** cùng SĐT + PIN → khôi phục số liệu đã nhập

Dữ liệu được lưu theo từng ngày trên trình duyệt (localStorage).

## Cách tính

```
Còn phải chạy = 1.200.000 − (tiền app + tiền ngoài − điểm Zoom × 80.000 − cao tốc)
```

- **Số tiền chạy trên app** — doanh thu qua app
- **Số tiền chạy ngoài** — doanh thu ngoài app
- **Số điểm trừ Zoom** — 1 điểm = −80.000đ, nhập từ 0.5 điểm
- **Số tiền cao tốc** — phí cao tốc phải trả

## Chạy local

Mở `index.html` bằng trình duyệt, hoặc:

```bash
python3 -m http.server 8080
```

Sau đó vào http://localhost:8080
