const playerURL = chrome.runtime.getURL("player.html");
const toggleEl = document.getElementById("toggle");
const stateEl = document.getElementById("state-label");

function renderState(enabled) {
  toggleEl.checked = enabled;
  stateEl.textContent = enabled
    ? "Enabled — intercepting unsupported videos"
    : "Disabled — videos are left to the browser";
}

chrome.storage.local.get({ enabled: true }).then(({ enabled }) => renderState(enabled));

toggleEl.addEventListener("change", async () => {
  await chrome.storage.local.set({ enabled: toggleEl.checked });
  renderState(toggleEl.checked);
});

function open(url) {
  chrome.tabs.create({ url });
  window.close();
}

document.getElementById("play").addEventListener("click", () => {
  const url = document.getElementById("url").value.trim();
  if (!url) return;
  open(`${playerURL}?enc=1&src=${encodeURIComponent(url)}`);
});

document.getElementById("open").addEventListener("click", () => open(playerURL));

document.getElementById("url").addEventListener("keydown", (e) => {
  if (e.key === "Enter") document.getElementById("play").click();
});

document.getElementById("advanced").addEventListener("click", (e) => {
  e.preventDefault();
  chrome.runtime.openOptionsPage();
});
