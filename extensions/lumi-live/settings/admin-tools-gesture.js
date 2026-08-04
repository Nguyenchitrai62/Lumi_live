export function createAdminToolsGesture({
  requiredClicks = 5,
  windowMs = 1_000,
  now = () => performance.now(),
  onUnlock = () => {},
} = {}) {
  let clickTimes = [];

  function registerClick() {
    const timestamp = Number(now());
    clickTimes = clickTimes.filter((value) => timestamp - value <= windowMs);
    clickTimes.push(timestamp);
    if (clickTimes.length < requiredClicks) return false;
    clickTimes = [];
    onUnlock();
    return true;
  }

  return Object.freeze({
    registerClick,
    reset() {
      clickTimes = [];
    },
  });
}
