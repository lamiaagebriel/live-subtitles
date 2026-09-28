import { defineConfig } from "wxt";

// See https://wxt.dev/api/config.html
export default defineConfig({
  manifest: {
    name: "Live Subtitles Anywhere",
    description:
      "Subtitles for any video on any website: live AI subtitles in any language, or load your own subtitle file perfectly synced.",
    icons: { 16: "icons/icon-16.png", 32: "icons/icon-32.png", 48: "icons/icon-48.png", 128: "icons/icon-128.png" },
    permissions: ["tabCapture", "offscreen", "storage", "activeTab", "scripting"],
    // Needed to inject the subtitle-file script into embedded players (iframes on other origins)
    host_permissions: ["<all_urls>"],
    action: {
      default_title: "Live Subtitles",
      default_icon: { 16: "icons/icon-16.png", 32: "icons/icon-32.png", 48: "icons/icon-48.png" }
    }
  }
});
