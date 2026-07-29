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

function projectMutationLabel(element) {
  return joinElementValues(element, [
    "innerText",
    "textContent",
    "aria-label",
    "title",
    "id",
    "name",
    "data-testid",
  ]);
}

function isProtectedProjectMutationControl(element, workPolicy = null) {
  const label = projectMutationLabel(element);
  const projectCard = element.closest?.('[data-testid^="div-project-card-"]');
  const mutationLabel = /(edit|delete|remove|save|update|archive|sửa|xóa|lưu|cập nhật|chỉnh sửa)/i;
  const stableMutationId = /(button-(?:edit|delete|remove|save|update)-project|edit-projects-grid-view)/i;
  const onProjectDetail = /^\/du-an\/(?!them(?:\/|$))[^/]+/i
    .test(String(workPolicy?.currentPath || ""));
  return stableMutationId.test(label)
    || (Boolean(projectCard) && mutationLabel.test(label))
    || (onProjectDetail && mutationLabel.test(label));
}

export function assertSafeErpProjectInput(_element, workPolicy = null) {
  if (
    workPolicy?.protectExistingProjects === true
    && workPolicy?.allowProjectMutation !== true
    && /^\/du-an\/(?!them(?:\/|$))[^/]+/i.test(String(workPolicy.currentPath || ""))
  ) {
    throw new Error(
      "Lumi Work Mode blocks editing a pre-existing ERP project. Only a new project created and verified in this Lumi conversation may be modified.",
    );
  }
}

export function assertConfirmedPageAgentClick(element, confirmed, workPolicy = null) {
  if (!element) return;
  const link = element.closest?.("a[href], area[href]");
  if (workPolicy?.lockToAllowedHost === true && link?.href) {
    try {
      const destination = new URL(link.href, globalThis.location?.href);
      if (
        ["http:", "https:"].includes(destination.protocol)
        && destination.hostname.toLowerCase() !== String(workPolicy.allowedHost || "").toLowerCase()
      ) {
        throw new Error(
          `Lumi Work Mode blocks this link because it leaves ${workPolicy.allowedHost}. Name the other website explicitly in a new prompt if it should become part of the task.`,
        );
      }
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("Lumi Work Mode blocks")) throw error;
    }
  }
  if (
    workPolicy?.protectExistingProjects === true
    && workPolicy?.allowProjectMutation !== true
    && isProtectedProjectMutationControl(element, workPolicy)
  ) {
    throw new Error(
      "Lumi Work Mode blocks modifying or deleting a pre-existing ERP project. Open the create-project flow or work only with a project Lumi created and verified in this conversation.",
    );
  }
  const label = joinElementValues(element, [
    "innerText",
    "textContent",
    "aria-label",
    "title",
  ]);
  if (HIGH_IMPACT_CLICK_PATTERN.test(label) && confirmed !== true) {
    throw new Error(
      `This looks like a consequential action (${label || "unlabeled control"}). Retry with confirmed=true only when the current user-authored request explicitly authorizes this exact action, target, and scope, or after later explicit confirmation.`,
    );
  }
}
