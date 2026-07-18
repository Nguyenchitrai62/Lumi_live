const MIN_ACTIVE_PETALS = 16;
const MAX_ACTIVE_PETALS = 28;

function randomBetween(min, max) {
  return min + Math.random() * (max - min);
}

export function createPetalEmitter({ field, isEnabled }) {
  let spawnTimer = null;
  let startFrame = null;

  function spawn(initialProgress = 0) {
    if (field.childElementCount >= MAX_ACTIVE_PETALS) return;

    const petal = document.createElement("i");
    const direction = Math.random() > .5 ? 1 : -1;
    const width = randomBetween(6, 11);
    const opacity = randomBetween(.34, .68);
    const duration = randomBetween(16, 26);

    petal.style.left = `${randomBetween(1, 97).toFixed(2)}%`;
    petal.style.width = `${width.toFixed(1)}px`;
    petal.style.height = `${(width * randomBetween(.58, .76)).toFixed(1)}px`;
    petal.style.setProperty("--drift-a", `${(direction * randomBetween(12, 48)).toFixed(1)}px`);
    petal.style.setProperty("--drift-b", `${(-direction * randomBetween(8, 42)).toFixed(1)}px`);
    petal.style.setProperty("--drift-c", `${(direction * randomBetween(22, 68)).toFixed(1)}px`);
    petal.style.setProperty("--turn-a", `${(direction * randomBetween(65, 145)).toFixed(0)}deg`);
    petal.style.setProperty("--turn-b", `${(direction * randomBetween(170, 285)).toFixed(0)}deg`);
    petal.style.setProperty("--turn-c", `${(direction * randomBetween(300, 520)).toFixed(0)}deg`);
    petal.style.setProperty("--petal-opacity", opacity.toFixed(2));
    petal.style.setProperty("--petal-fade-opacity", (opacity * .36).toFixed(2));
    petal.style.setProperty("--petal-scale", randomBetween(.72, 1.18).toFixed(2));
    petal.style.animationDuration = `${duration.toFixed(2)}s`;
    if (initialProgress > 0) {
      petal.style.animationDelay = `${-(duration * initialProgress).toFixed(2)}s`;
    }
    petal.addEventListener("animationend", () => {
      petal.remove();
      if (isEnabled()) ensureDensity();
    }, { once: true });
    field.append(petal);
  }

  function ensureDensity() {
    while (field.childElementCount < MIN_ACTIVE_PETALS) {
      spawn(randomBetween(.08, .88));
    }
  }

  function scheduleNext() {
    spawnTimer = setTimeout(() => {
      spawnTimer = null;
      if (!isEnabled()) return;
      ensureDensity();
      spawn();
      scheduleNext();
    }, randomBetween(420, 1100));
  }

  function start() {
    if (spawnTimer !== null || startFrame !== null) return;
    startFrame = requestAnimationFrame(() => {
      startFrame = requestAnimationFrame(() => {
        startFrame = null;
        if (!isEnabled()) return;
        field.classList.remove("petal-field-entering");
        void field.offsetWidth;
        field.classList.add("petal-field-entering");
        ensureDensity();
        scheduleNext();
      });
    });
  }

  function stop() {
    if (startFrame !== null) cancelAnimationFrame(startFrame);
    if (spawnTimer !== null) clearTimeout(spawnTimer);
    startFrame = null;
    spawnTimer = null;
    field.classList.remove("petal-field-entering");
    field.replaceChildren();
  }

  function restart() {
    stop();
    if (isEnabled()) start();
  }

  return { restart, start, stop };
}
