const accountCopy = document.querySelector("#accountCopy");
const accountLogoutButton = document.querySelector("#accountLogoutButton");
const accountRole = document.querySelector("#accountRole");
const accountUsername = document.querySelector("#accountUsername");
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
    ? "Authenticator is enabled for this account."
    : "Protect your Chatterbox account with Google Authenticator.";
  twofaStartButton.hidden = enabled;
  twofaVerifyButton.hidden = enabled || twofaSetup.hidden;
  twofaCode.hidden = enabled;
  if (enabled) {
    twofaSetup.hidden = true;
    setTwofaStatus("Authenticator enabled.", false);
  }
}

async function loadAccount() {
  const state = await requestJson("/api/auth/status");
  if (!state.authenticated) {
    window.location.href = "/login";
    return;
  }
  if (state.user.role === "admin") {
    window.location.href = "/admin";
    return;
  }
  accountUsername.textContent = state.user.username;
  accountRole.textContent = "Customer";
  accountCopy.textContent = "Customer license tools will appear here as the purchase flow is added.";
  const account = await requestJson("/api/account/me");
  renderTwofa(account.user);
}

twofaStartButton.addEventListener("click", async () => {
  setTwofaStatus("");
  twofaStartButton.disabled = true;
  try {
    const data = await requestJson("/api/account/2fa/setup", { method: "POST", body: "{}" });
    twofaQr.src = data.qrCode;
    twofaSecret.textContent = data.secret;
    twofaSetup.hidden = false;
    twofaStartButton.hidden = true;
    twofaVerifyButton.hidden = false;
    twofaCode.hidden = false;
    twofaCode.focus();
    setTwofaStatus("Scan the QR code, then enter the 6-digit code.", false);
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
    const data = await requestJson("/api/account/2fa/verify", {
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

accountLogoutButton.addEventListener("click", async () => {
  await requestJson("/api/auth/logout", { method: "POST", body: "{}" });
  window.location.href = "/login";
});

loadAccount().catch(() => {
  window.location.href = "/login";
});
