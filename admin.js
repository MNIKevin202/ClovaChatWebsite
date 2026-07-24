const adminCopy = document.querySelector("#adminCopy");
const adminUsername = document.querySelector("#adminUsername");
const durationRow = document.querySelector("#durationRow");
const licenseForm = document.querySelector("#licenseForm");
const licenseActive = document.querySelector("#licenseActive");
const licenseActivated = document.querySelector("#licenseActivated");
const licenseLifetime = document.querySelector("#licenseLifetime");
const licenseStatus = document.querySelector("#licenseStatus");
const licenseTable = document.querySelector("#licenseTable");
const licenseType = document.querySelector("#licenseType");
const licenseAccount = document.querySelector("#licenseAccount");
const licenseTotal = document.querySelector("#licenseTotal");
const logoutButton = document.querySelector("#logoutButton");
const refreshLicenses = document.querySelector("#refreshLicenses");
const twofaCard = document.querySelector("#twofaCard");
const twofaBadge = document.querySelector("#twofaBadge");
const twofaCode = document.querySelector("#twofaCode");
const twofaCopy = document.querySelector("#twofaCopy");
const twofaForm = document.querySelector("#twofaForm");
const twofaQr = document.querySelector("#twofaQr");
const twofaSecret = document.querySelector("#twofaSecret");
const twofaSetup = document.querySelector("#twofaSetup");
const twofaStartButton = document.querySelector("#twofaStartButton");
const twofaStatus = document.querySelector("#twofaStatus");
const twofaVerifyButton = document.querySelector("#twofaVerifyButton");
const requiredUpdateCard = document.querySelector("#requiredUpdateCard");
const requiredUpdateBadge = document.querySelector("#requiredUpdateBadge");
const requiredUpdateCopy = document.querySelector("#requiredUpdateCopy");
const requiredUpdateForm = document.querySelector("#requiredUpdateForm");
const requiredUpdateVersion = document.querySelector("#requiredUpdateVersion");
const requiredUpdateClearButton = document.querySelector("#requiredUpdateClearButton");
const requiredUpdateStatus = document.querySelector("#requiredUpdateStatus");

async function requestJson(url, options = {}) {
  const response = await fetch(url, {
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    ...options
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || "Request failed.");
  return body;
}

function formatDate(value) {
  if (!value) return "Never";
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short"
  }).format(new Date(value));
}

function licenseTypeLabel(license) {
  if (license.type === "lifetime") return "Lifetime";
  return `Trial: ${license.durationAmount} ${license.durationUnit}`;
}

function updateStats(licenses) {
  licenseTotal.textContent = licenses.length;
  licenseActive.textContent = licenses.filter((license) => license.status === "active").length;
  licenseActivated.textContent = licenses.filter((license) => license.deviceId).length;
  licenseLifetime.textContent = licenses.filter((license) => license.type === "lifetime").length;
}

function setStatus(message, isError = false) {
  licenseStatus.textContent = message;
  licenseStatus.classList.toggle("is-ok", Boolean(message && !isError));
}

function setTwofaStatus(message, isError = false) {
  twofaStatus.textContent = message;
  twofaStatus.classList.toggle("is-ok", Boolean(message && !isError));
}

function renderTwofa(user) {
  twofaCard.hidden = false;
  const enabled = Boolean(user?.totpEnabled);
  twofaCard.classList.toggle("is-enabled", enabled);
  twofaBadge.textContent = enabled ? "Enabled" : "Not enabled";
  twofaCopy.textContent = enabled
    ? "Google Authenticator is enabled for this admin account."
    : "Set up Google Authenticator before using admin login in the desktop app.";
  twofaStartButton.hidden = enabled;
  twofaVerifyButton.hidden = enabled || twofaSetup.hidden;
  twofaCode.hidden = enabled;
  if (enabled) {
    twofaSetup.hidden = true;
    setTwofaStatus("Authenticator enabled.", false);
  }
}

function renderAccountOptions(users) {
  const options = ['<option value="">No account selected</option>'];
  options.push(...users.map((user) => `<option value="${user.username}">${user.username}</option>`));
  licenseAccount.innerHTML = options.join("");
}

async function loadAccounts() {
  const data = await requestJson("/api/admin/users");
  renderAccountOptions(data.users || []);
}

function renderLicenses(licenses) {
  updateStats(licenses);
  if (!licenses.length) {
    licenseTable.innerHTML = '<p class="empty-state">No licenses yet. Create a trial or lifetime key to get started.</p>';
    return;
  }

  licenseTable.innerHTML = licenses.map((license) => `
    <article class="license-row status-border-${license.status}" data-id="${license.id}">
      <div class="license-code-block">
        <div class="license-card-top">
          <span class="license-type">${licenseTypeLabel(license)}</span>
          <strong class="status-pill status-${license.status}">${license.status}</strong>
        </div>
        <code>${license.code}</code>
      </div>
      <div class="license-meta">
        <span class="admin-label">Expires</span>
        <strong>${formatDate(license.expiresAt)}</strong>
      </div>
      <div class="license-meta">
        <span class="admin-label">Device</span>
        <strong>${license.deviceId ? "Activated" : "Unused"}</strong>
      </div>
      <div class="license-meta">
        <span class="admin-label">Account</span>
        <strong>${license.assignedUsername || "Unassigned"}</strong>
      </div>
      <div class="license-actions">
        <button class="button button-secondary" data-copy="${license.code}" type="button">Copy</button>
        <button class="button button-secondary" data-revoke="${license.id}" ${license.revokedAt ? "disabled" : ""} type="button">Revoke</button>
      </div>
      ${license.label || license.notes ? `
        <p class="license-note">${[license.label, license.notes].filter(Boolean).join(" - ")}</p>
      ` : ""}
    </article>
  `).join("");
}

async function loadLicenses() {
  const data = await requestJson("/api/admin/licenses");
  renderLicenses(data.licenses);
}

function setRequiredUpdateStatus(message, isError = false) {
  requiredUpdateStatus.textContent = message;
  requiredUpdateStatus.classList.toggle("is-ok", Boolean(message && !isError));
}

function renderRequiredUpdate(version) {
  const has = Boolean(version);
  requiredUpdateBadge.textContent = has ? `v${version}+` : "Not set";
  requiredUpdateCard.classList.toggle("is-enabled", has);
  requiredUpdateCopy.textContent = has
    ? `Chatterbox app users below v${version} are being blocked with a mandatory update prompt.`
    : "No version is currently required. Everyone can stay on their current build.";
}

async function loadRequiredUpdateVersions(selected) {
  try {
    const [latest, history] = await Promise.all([
      requestJson("/api/releases/latest").catch(() => null),
      requestJson("/api/releases/history").catch(() => ({ releases: [] }))
    ]);
    const versions = [];
    if (latest?.version) versions.push(latest.version);
    for (const release of history.releases || []) {
      if (release.version && !versions.includes(release.version)) versions.push(release.version);
    }
    if (selected && !versions.includes(selected)) versions.push(selected);
    requiredUpdateVersion.innerHTML = ['<option value="">No version selected</option>']
      .concat(versions.map((version) => `<option value="${version}">v${version}</option>`))
      .join("");
    if (selected) requiredUpdateVersion.value = selected;
  } catch {
    // Best-effort — the dropdown just stays empty if the release list can't be fetched.
  }
}

async function loadRequiredUpdate() {
  try {
    const data = await requestJson("/api/admin/required-version");
    renderRequiredUpdate(data.requiredVersion);
    await loadRequiredUpdateVersions(data.requiredVersion);
  } catch (error) {
    setRequiredUpdateStatus(error.message, true);
  }
}

requiredUpdateForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  setRequiredUpdateStatus("");
  const version = requiredUpdateVersion.value;
  if (!version) {
    setRequiredUpdateStatus("Pick a version first.", true);
    return;
  }
  const submit = requiredUpdateForm.querySelector("button[type='submit']");
  submit.disabled = true;
  try {
    const data = await requestJson("/api/admin/required-version", {
      method: "POST",
      body: JSON.stringify({ version })
    });
    renderRequiredUpdate(data.requiredVersion);
    setRequiredUpdateStatus(`Version ${data.requiredVersion} is now required.`, false);
  } catch (error) {
    setRequiredUpdateStatus(error.message, true);
  } finally {
    submit.disabled = false;
  }
});

requiredUpdateClearButton.addEventListener("click", async () => {
  setRequiredUpdateStatus("");
  requiredUpdateClearButton.disabled = true;
  try {
    const data = await requestJson("/api/admin/required-version", {
      method: "POST",
      body: JSON.stringify({ version: "" })
    });
    renderRequiredUpdate(data.requiredVersion);
    requiredUpdateVersion.value = "";
    setRequiredUpdateStatus("Update requirement cleared.", false);
  } catch (error) {
    setRequiredUpdateStatus(error.message, true);
  } finally {
    requiredUpdateClearButton.disabled = false;
  }
});

async function loadAdmin() {
  try {
    const data = await requestJson("/api/admin/me");
    adminUsername.textContent = data.user.username;
    adminCopy.textContent = "Create trial and lifetime license codes for Chatterbox.";
    renderTwofa(data.user);
    initDownloadPanel();
    await loadAccounts();
    await loadLicenses();
    await loadRequiredUpdate();
  } catch {
    window.location.href = "/login";
  }
}

licenseType.addEventListener("change", () => {
  durationRow.hidden = licenseType.value === "lifetime";
});

licenseForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  setStatus("");
  const submit = licenseForm.querySelector("button[type='submit']");
  submit.disabled = true;
  const formData = new FormData(licenseForm);
  try {
    const payload = {
      durationAmount: Number(formData.get("durationAmount")),
      durationUnit: formData.get("durationUnit"),
      label: formData.get("label"),
      notes: formData.get("notes"),
      accountUsername: formData.get("accountUsername"),
      type: formData.get("type")
    };
    const data = await requestJson("/api/admin/licenses", {
      method: "POST",
      body: JSON.stringify(payload)
    });
    await navigator.clipboard?.writeText(data.license.code).catch(() => {});
    setStatus("License created. Code copied to clipboard.", false);
    licenseForm.reset();
    durationRow.hidden = false;
    await loadLicenses();
  } catch (error) {
    setStatus(error.message, true);
  } finally {
    submit.disabled = false;
  }
});

licenseTable.addEventListener("click", async (event) => {
  const copyButton = event.target.closest("[data-copy]");
  const copyCode = copyButton?.dataset.copy;
  if (copyCode) {
    await navigator.clipboard?.writeText(copyCode).catch(() => {});
    copyButton.textContent = "Copied";
    copyButton.disabled = true;
    setTimeout(() => {
      copyButton.textContent = "Copy";
      copyButton.disabled = false;
    }, 1400);
    setStatus("License code copied.", false);
    return;
  }

  const revokeId = event.target.closest("[data-revoke]")?.dataset.revoke;
  if (revokeId) {
    await requestJson(`/api/admin/licenses/${revokeId}/revoke`, { method: "POST", body: "{}" });
    setStatus("License revoked.", false);
    await loadLicenses();
  }
});

refreshLicenses.addEventListener("click", loadLicenses);

twofaStartButton.addEventListener("click", async () => {
  setTwofaStatus("");
  twofaStartButton.disabled = true;
  try {
    const data = await requestJson("/api/admin/2fa/setup", { method: "POST", body: "{}" });
    twofaQr.src = data.qrCode;
    twofaSecret.textContent = data.secret;
    twofaSetup.hidden = false;
    twofaStartButton.hidden = true;
    twofaVerifyButton.hidden = false;
    twofaCode.hidden = false;
    twofaCode.focus();
    setTwofaStatus("Scan the QR code in Google Authenticator, then enter the 6-digit code.", false);
  } catch (error) {
    setTwofaStatus(error.message, true);
  } finally {
    twofaStartButton.disabled = false;
  }
});

twofaForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  setTwofaStatus("");
  twofaVerifyButton.disabled = true;
  try {
    const data = await requestJson("/api/admin/2fa/verify", {
      method: "POST",
      body: JSON.stringify({ code: twofaCode.value.trim() })
    });
    twofaCode.value = "";
    renderTwofa(data.user);
  } catch (error) {
    setTwofaStatus(error.message, true);
  } finally {
    twofaVerifyButton.disabled = false;
  }
});

logoutButton.addEventListener("click", async () => {
  await requestJson("/api/auth/logout", { method: "POST", body: "{}" });
  window.location.href = "/login";
});

loadAdmin();
