# Mục tiêu chạy xe

Trang web tính toán mục tiêu thu nhập hàng ngày khi chạy xe.

## Mục tiêu

**1.200.000đ / ngày**

## Cách sử dụng

Mở file `index.html` trên trình duyệt (điện thoại hoặc máy tính).

Nhập các khoản:

| Trường | Mô tả |
|--------|-------|
| Số tiền chạy trên app | Thu nhập từ ứng dụng |
| Số tiền chạy ngoài | Thu nhập ngoài app |
| Số điểm trừ trên Zoom | Mỗi 0.5 điểm, 1 điểm = trừ 80.000đ |
| Số tiền cao tốc phải trả | Phí cao tốc |

## Công thức

```
Thực nhận = (Tiền app + Tiền ngoài) − (Điểm Zoom × 80.000) − Tiền cao tốc
Còn phải chạy = 1.200.000 − Thực nhận
```
