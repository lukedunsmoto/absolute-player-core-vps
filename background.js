// Service worker: registers the redirect rule for direct navigations to
// unsupported video files, a context-menu entry for links, and keeps both
// in sync with the enable/disable toggle (chrome.storage.local "enabled").

// Extensions redirected when the user navigates straight to the file.
// Note: bare ".ts" is deliberately excluded here (TypeScript source files);
// embedded <video> elements with .ts sources are still handled by content.js.
const NAV_EXT_REGEX =
  "^(https?|file)://.*\\.(mkv|avi|flv|wmv|m2ts|mts|vob|mpe?g|3gp|f4v|ogm|rm|rmvb|asf|divx)(\\?[^#]*)?(#.*)?$";

const PLAYER_URL = chrome.runtime.getURL("player.html");
const MENU_ID = "wasm-player-open-link";

async function isEnabled() {
  const { enabled = true } = await chrome.storage.local.get("enabled");
  return enabled;
}

async function syncState() {
  const enabled = await isEnabled();

  const existing = await chrome.declarativeNetRequest.getDynamicRules();
  await chrome.declarativeNetRequest.updateDynamicRules({
    removeRuleIds: existing.map((r) => r.id),
    addRules: enabled
      ? [
          {
            id: 1,
            priority: 1,
            action: {
              type: "redirect",
              // \0 = the whole matched URL, appended un-encoded; player.html
              // parses everything after "?src=" as the raw source URL.
              redirect: { regexSubstitution: `${PLAYER_URL}?src=\\0` },
            },
            condition: {
              regexFilter: NAV_EXT_REGEX,
              isUrlFilterCaseSensitive: false,
              resourceTypes: ["main_frame"],
            },
          },
        ]
      : [],
  });

  try {
    await chrome.contextMenus.update(MENU_ID, { enabled });
  } catch {
    // menu may not exist yet (first run before onInstalled) — harmless
  }

  chrome.action.setBadgeText({ text: enabled ? "" : "OFF" });
  chrome.action.setBadgeBackgroundColor({ color: "#6b7280" });
}

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create(
    {
      id: MENU_ID,
      title: "Play link with AbsolutePlayer",
      contexts: ["link"],
    },
    () => chrome.runtime.lastError // ignore "already exists" on reload
  );
  syncState();
});

chrome.runtime.onStartup.addListener(syncState);

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.enabled) syncState();
});

chrome.contextMenus.onClicked.addListener((info) => {
  if (info.menuItemId === MENU_ID && info.linkUrl) {
    chrome.tabs.create({
      url: `${PLAYER_URL}?enc=1&src=${encodeURIComponent(info.linkUrl)}`,
    });
  }
});
