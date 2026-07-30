const workspaceMenu = document.querySelector("#workspaceMenu");
const menuPanel = document.querySelector("#menuPanel");
workspaceMenu?.addEventListener("click", () => {
  const expanded = workspaceMenu.getAttribute("aria-expanded") === "true";
  workspaceMenu.setAttribute("aria-expanded", String(!expanded));
  menuPanel.hidden = expanded;
});

for (const tab of document.querySelectorAll("[role='tab']")) {
  tab.addEventListener("click", () => {
    for (const item of document.querySelectorAll("[role='tab']")) {
      item.setAttribute("aria-selected", String(item === tab));
    }
    document.querySelector("#activityPanel").hidden = tab.dataset.tab !== "activity";
    document.querySelector("#metricsPanel").hidden = tab.dataset.tab !== "metrics";
  });
}

const helpDialog = document.querySelector("#helpDialog");
document.querySelector("#helpButton")?.addEventListener("click", () => helpDialog.showModal());
document.querySelector("#closeHelp")?.addEventListener("click", () => helpDialog.close());

for (const disclosure of document.querySelectorAll("[data-project-details]")) {
  disclosure.addEventListener("click", () => {
    const expanded = disclosure.getAttribute("aria-expanded") === "true";
    disclosure.setAttribute("aria-expanded", String(!expanded));
    disclosure.nextElementSibling.hidden = expanded;
  });
}
