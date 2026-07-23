const PLATFORM_LABELS = {
  mac: "macOS (.dmg)",
  windows: "Windows (.exe)"
};

const DOWNLOAD_POLL_MS = 60_000;
let hasLoadedRelease = false;

function formatSize(bytes) {
  if (!bytes) return "";
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatDate(iso) {
  if (!iso) return "";
  return new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "long", year: "numeric" });
}

async function refreshDownloadPanel() {
  const card = document.querySelector("#downloadCard");
  const badge = document.querySelector("#downloadVersionBadge");
  const copy = document.querySelector("#downloadCopy");
  const assetsEl = document.querySelector("#downloadAssets");
  const notesWrap = document.querySelector("#downloadNotes");
  const notesBody = document.querySelector("#downloadNotesBody");
  if (!card || !badge || !assetsEl) return;

  try {
    const response = await fetch("/api/releases/latest", { credentials: "same-origin" });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      if (!hasLoadedRelease) copy.textContent = data.error || "Downloads are not available right now.";
      return;
    }

    hasLoadedRelease = true;
    badge.textContent = data.version ? `v${data.version}` : "Unreleased";
    const published = formatDate(data.publishedAt);
    copy.textContent = published
      ? `${data.name || "Latest release"} · released ${published}.`
      : data.name || "Latest release.";

    assetsEl.innerHTML = "";
    if (!data.assets || !data.assets.length) {
      const empty = document.createElement("p");
      empty.className = "download-empty";
      empty.textContent = "No installers are attached to the latest release yet.";
      assetsEl.append(empty);
    } else {
      for (const asset of data.assets) {
        const row = document.createElement("div");
        row.className = "download-asset";
        const link = document.createElement("a");
        link.className = "button button-primary";
        link.href = asset.downloadUrl;
        link.textContent = `Download for ${PLATFORM_LABELS[asset.platform] || asset.name}`;
        row.append(link);
        const size = formatSize(asset.size);
        if (size) {
          const sizeSpan = document.createElement("span");
          sizeSpan.className = "download-size";
          sizeSpan.textContent = size;
          row.append(sizeSpan);
        }
        assetsEl.append(row);
      }
    }

    notesWrap.hidden = !data.notes;
    if (data.notes) notesBody.textContent = data.notes;
  } catch {
    if (!hasLoadedRelease) copy.textContent = "Could not check for the latest release.";
  }
}

function initDownloadPanel() {
  void refreshDownloadPanel();
  setInterval(() => void refreshDownloadPanel(), DOWNLOAD_POLL_MS);
}
