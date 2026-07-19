const SENSITIVE_INPUT_PATTERN = /(password|passcode|mật.?khẩu|mat.?khau|otp|one.?time|mã.?xác.?thực|ma.?xac.?thuc|credit.?card|card.?number|thẻ.?tín.?dụng|the.?tin.?dung|cvv|cvc|api.?key|khóa.?api|khoa.?api|secret|bí.?mật|bi.?mat|access.?token)/i;

const HIGH_IMPACT_CLICK_PATTERN = /(submit|send|gửi|gui|publish|xuất.?bản|xuat.?ban|post|đăng|dang|pay|thanh.?toán|thanh.?toan|purchase|buy now|mua.?ngay|place order|đặt.?hàng|dat.?hang|delete|xóa|xoa|remove account|xóa.?tài.?khoản|xoa.?tai.?khoan|confirm order|xác.?nhận.?đơn|xac.?nhan.?don|authorize|ủy.?quyền|uy.?quyen|transfer|chuyển.?tiền|chuyen.?tien|unsubscribe|hủy.?đăng.?ký|huy.?dang.?ky|save password)/i;

function joinElementValues(element, values) {
  return values
    .map((name) => name in element
      ? element[name]
      : element.getAttribute?.(name))
    .filter(Boolean)
    .join(" ")
    .trim()
    .slice(0, 240);
}

export function assertSafePageAgentInput(element) {
  if (!element) return;
  const descriptor = joinElementValues(element, [
    "type",
    "name",
    "id",
    "autocomplete",
    "aria-label",
    "placeholder",
  ]);
  if (SENSITIVE_INPUT_PATTERN.test(descriptor)) {
    throw new Error("Lumi blocks typing passwords, OTPs, payment-card data, API keys, and other secrets.");
  }
}

export function assertConfirmedPageAgentClick(element, confirmed) {
  if (!element) return;
  const label = joinElementValues(element, [
    "innerText",
    "textContent",
    "aria-label",
    "title",
  ]);
  if (HIGH_IMPACT_CLICK_PATTERN.test(label) && confirmed !== true) {
    throw new Error(
      `This looks like a consequential action (${label || "unlabeled control"}). Ask for explicit confirmation, then retry with confirmed=true.`,
    );
  }
}
