const form = document.querySelector("#authForm");
const adminSetupLink = document.querySelector("#adminSetupLink");
const authSwitch = document.querySelector("#authSwitch");
const statusText = document.querySelector("#authStatus");
const submitButton = document.querySelector("#authSubmit");
const verificationCode = document.querySelector("#verificationCode");
const verificationCodeRow = document.querySelector("#verificationCodeRow");
const usernameRow = document.querySelector("#usernameRow");
const passwordRow = document.querySelector("#passwordRow");
let twoFactorStep = false;
let adminSetupAvailable = false;

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

function destinationFor(user) {
  return user?.role === "admin" ? "/admin" : "/account";
}

function setTwoFactorStep(enabled) {
  twoFactorStep = enabled;
  usernameRow.hidden = enabled;
  passwordRow.hidden = enabled;
  verificationCodeRow.hidden = !enabled;
  verificationCode.required = enabled;
  if (authSwitch) authSwitch.hidden = enabled;
  if (adminSetupLink) adminSetupLink.hidden = enabled || !adminSetupAvailable;
  submitButton.textContent = enabled ? "Verify Code" : "Login";
}

function resetTwoFactorStep() {
  setTwoFactorStep(false);
  verificationCode.value = "";
}

async function loadAuthState() {
  const state = await requestJson("/api/auth/status");
  if (state.authenticated) {
    window.location.href = state.redirectTo || destinationFor(state.user);
    return;
  }

  if (adminSetupLink) {
    const setupState = await requestJson("/api/admin/setup-status");
    adminSetupAvailable = Boolean(setupState.available);
    adminSetupLink.hidden = !adminSetupAvailable;
  }
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  statusText.textContent = "";
  submitButton.disabled = true;
  const formData = new FormData(form);
  try {
    const data = await requestJson("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({
        password: formData.get("password"),
        verificationCode: twoFactorStep ? formData.get("verificationCode") : "",
        username: formData.get("username")
      })
    });
    if (data.requiresTwoFactor) {
      setTwoFactorStep(true);
      verificationCode.focus();
      statusText.textContent = "Enter the 6-digit code from your authenticator app.";
      return;
    }
    window.location.href = data.redirectTo || destinationFor(data.user);
  } catch (error) {
    statusText.textContent = error.message;
  } finally {
    submitButton.disabled = false;
  }
});

form.username?.addEventListener("input", resetTwoFactorStep);
form.password?.addEventListener("input", resetTwoFactorStep);

loadAuthState().catch((error) => {
  statusText.textContent = error.message;
});
