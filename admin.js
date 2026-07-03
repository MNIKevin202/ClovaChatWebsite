const adminCopy = document.querySelector("#adminCopy");
const adminUsername = document.querySelector("#adminUsername");
const durationRow = document.querySelector("#durationRow");
const licenseForm = document.querySelector("#licenseForm");
const licenseStatus = document.querySelector("#licenseStatus");
const licenseTable = document.querySelector("#licenseTable");
const licenseType = document.querySelector("#licenseType");
const logoutButton = document.querySelector("#logoutButton");
const refreshLicenses = document.querySelector("#refreshLicenses");

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

function setStatus(message, isError = false) {
  licenseStatus.textContent = message;
  licenseStatus.classList.toggle("is-ok", Boolean(message && !isError));
}

function renderLicenses(licenses) {
  if (!licenses.length) {
    licenseTable.innerHTML = '<p class="empty-state">No licenses yet.</p>';
    return;
  }

  licenseTable.innerHTML = licenses.map((license) => `
    <article class="license-row" data-id="${license.id}">
      <div class="license-code-block">
        <span class="admin-label">${licenseTypeLabel(license)}</span>
        <code>${license.code}</code>
      </div>
      <div>
        <span class="admin-label">Status</span>
        <strong class="status-pill status-${license.status}">${license.status}</strong>
      </div>
      <div>
        <span class="admin-label">Expires</span>
        <strong>${formatDate(license.expiresAt)}</strong>
      </div>
      <div>
        <span class="admin-label">Device</span>
        <strong>${license.deviceId ? "Activated" : "Unused"}</strong>
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

async function loadAdmin() {
  try {
    const data = await requestJson("/api/admin/me");
    adminUsername.textContent = data.user.username;
    adminCopy.textContent = "Create trial and lifetime license codes for ClovaChat.";
    await loadLicenses();
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

logoutButton.addEventListener("click", async () => {
  await requestJson("/api/auth/logout", { method: "POST", body: "{}" });
  window.location.href = "/login";
});

loadAdmin();
