const accountCopy = document.querySelector("#accountCopy");
const accountLogoutButton = document.querySelector("#accountLogoutButton");
const accountRole = document.querySelector("#accountRole");
const accountUsername = document.querySelector("#accountUsername");

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
}

accountLogoutButton.addEventListener("click", async () => {
  await requestJson("/api/auth/logout", { method: "POST", body: "{}" });
  window.location.href = "/login";
});

loadAccount().catch(() => {
  window.location.href = "/login";
});
