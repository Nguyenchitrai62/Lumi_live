// Default settings
// Thinking mặc định. Options: "minimal", "low", "medium", "high".
export const DEFAULT_THINKING_LEVEL = "minimal";
// Giọng Gemini mặc định. Options: tên bất kỳ trong danh sách voice của Gemini Live.
export const DEFAULT_VOICE_NAME = "Zephyr";
// Avatar mặc định. Options: "pixel", "vtuber".
export const DEFAULT_AVATAR_MODE = "pixel";
// Hiển thị cánh hoa nền mặc định. Options: true, false.
export const DEFAULT_FALLING_PETALS_ENABLED = true;
// Tự kết nối khi side panel mở và đã có key/microphone. Options: true, false.
export const DEFAULT_AUTO_CONNECT_ENABLED = true;
// Hiển thị highlight phần tử PageAgent mặc định. Options: true, false.
export const DEFAULT_SHOW_ELEMENT_HIGHLIGHTS = false;

// Transcript and expandable content
// Tốc độ reveal Thinking/content khi nhận một khối text lớn (ký tự/giây).
export const TRANSCRIPT_REVEAL_CHARACTERS_PER_SECOND = 800;
// Thời gian reveal tối thiểu cho khối text ngắn (ms).
export const TRANSCRIPT_REVEAL_MINIMUM_DURATION_MS = 16;
// Thời gian mở/thu gọn Thinking và MCP (ms).
export const DISCLOSURE_ANIMATION_DURATION_MS = 500;

// Side-panel effects
// Thời gian phản hồi nhanh khi hover/click control trong side panel (ms).
export const SIDE_PANEL_FAST_FEEDBACK_DURATION_MS = 160;
// Thời gian phản hồi chuẩn của button/form trong side panel (ms).
export const SIDE_PANEL_STANDARD_FEEDBACK_DURATION_MS = 200;
// Thời gian phóng to/thu nhỏ avatar panel (ms).
export const SIDE_PANEL_EXPANSION_DURATION_MS = 320;
// Thời gian mờ dần của lớp cánh hoa (ms).
export const SIDE_PANEL_PETAL_FADE_DURATION_MS = 280;
// Thời gian cánh hoa bắt đầu xuất hiện (ms).
export const SIDE_PANEL_PETAL_ENTRANCE_DURATION_MS = 1200;
// Chu kỳ chuyển động nền gradient (ms).
export const SIDE_PANEL_BACKGROUND_DRIFT_DURATION_MS = 16000;
// Độ lệch thời điểm giữa hai lớp nền gradient (ms).
export const SIDE_PANEL_BACKGROUND_WASH_OFFSET_MS = 8000;
// Chu kỳ chấm trạng thái Live Translate (ms).
export const SIDE_PANEL_TRANSLATION_PULSE_DURATION_MS = 1350;
// Chu kỳ chấm trạng thái Thinking đang stream (ms).
export const SIDE_PANEL_THINKING_PULSE_DURATION_MS = 1000;
// Chu kỳ icon loading của MCP tool (ms).
export const SIDE_PANEL_MCP_SPINNER_DURATION_MS = 800;
// Chu kỳ pulse của nút hủy turn (ms).
export const SIDE_PANEL_CANCEL_PULSE_DURATION_MS = 1500;
// Thời gian animation khi hệ điều hành bật reduced motion (ms).
export const SIDE_PANEL_REDUCED_MOTION_DURATION_MS = 1;
// Thời gian avatar hiển thị trạng thái thành công (ms).
export const AVATAR_SUCCESS_STATE_DURATION_MS = 1760;
// Thời gian avatar hiển thị trạng thái lỗi (ms).
export const AVATAR_ERROR_STATE_DURATION_MS = 2080;
// Thời gian rơi ngắn nhất của một cánh hoa (giây).
export const PETAL_FALL_MINIMUM_DURATION_SECONDS = 16;
// Thời gian rơi dài nhất của một cánh hoa (giây).
export const PETAL_FALL_MAXIMUM_DURATION_SECONDS = 26;

// Browser click, form input, and scroll effects
// Thời gian vòng ripple của con trỏ khi PageAgent click (ms).
export const BROWSER_CLICK_RIPPLE_DURATION_MS = 300;
// Thời gian giữ lớp hiệu ứng sau mỗi browser action trước khi dọn (ms).
export const BROWSER_ACTION_CLEANUP_DELAY_MS = 420;
// Thời gian điền dần toàn bộ nội dung vào input, textarea hoặc contenteditable (ms).
export const FORM_INPUT_REVEAL_DURATION_MS = 500;
// Thời gian cuộn một browser_scroll (ms).
export const PAGE_SCROLL_DURATION_MS = 1000;
// Thời gian viền hiệu ứng scroll xuất hiện (ms).
export const PAGE_SCROLL_FRAME_ENTRANCE_DURATION_MS = 180;
// Thời gian HUD hiệu ứng scroll trượt vào (ms).
export const PAGE_SCROLL_HUD_ENTRANCE_DURATION_MS = 220;
// Chu kỳ mũi tên trong HUD scroll (ms).
export const PAGE_SCROLL_ARROW_PULSE_DURATION_MS = 720;
// Thời gian HUD/viền scroll mờ đi khi hoàn thành (ms).
export const PAGE_SCROLL_EXIT_DURATION_MS = 160;
// Khoảng chờ trước khi xóa HUD/viền scroll đã hoàn thành (ms).
export const PAGE_SCROLL_CLEANUP_DELAY_MS = 170;

// Google departure effect
// Thời gian màn Google transition xuất hiện (ms).
export const GOOGLE_STAGE_ENTRANCE_DURATION_MS = 1000;
// Thời gian hiện dần query trong ô Google Search (ms).
export const GOOGLE_QUERY_REVEAL_DURATION_MS = 500;
// Chu kỳ nháy caret trong ô Google Search (ms).
export const GOOGLE_CARET_BLINK_DURATION_MS = 700;
// Thời gian phản hồi visual của nút Google Search khi click (ms).
export const GOOGLE_BUTTON_FEEDBACK_DURATION_MS = 100;
// Thời gian con trỏ di chuyển tới nút Google Search (ms).
export const GOOGLE_POINTER_AIM_DURATION_MS = 360;
// Thời gian vòng ripple khi click Google Search (ms).
export const GOOGLE_CLICK_RING_DURATION_MS = 240;
// Khoảng chờ sau click Google Search trước khi chuyển tab (ms).
export const GOOGLE_POST_CLICK_DELAY_MS = 120;
// Khoảng chờ trước khi tự xóa hiệu ứng Google nếu tab chưa chuyển (ms).
export const GOOGLE_EFFECT_CLEANUP_DELAY_MS = 12000;
