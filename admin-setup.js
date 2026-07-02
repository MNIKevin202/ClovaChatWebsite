const adminSetupForm = document.querySelector("#adminSetupForm");
const adminSetupStatus = document.querySelector("#adminSetupStatus");
const adminSetupSubmit = document.querySelector("#adminSetupSubmit");

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

async function loadSetupState() {
  const authState = await requestJson("/api/auth/status");
  if (authState.authenticated) {
    window.location.href = authState.redirectTo || "/account";
    return;
  }

  const setupState = await requestJson("/api/admin/setup-status");
  if (!setupState.available) {
    adminSetupForm.hidden = true;
    adminSetupStatus.textContent = "Admin setup is already complete. Use the login page.";
  }
}

adminSetupForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  adminSetupStatus.textContent = "";
  adminSetupSubmit.disabled = true;
  const formData = new FormData(adminSetupForm);
  try {
    const data = await requestJson("/api/admin/setup", {
      method: "POST",
      body: JSON.stringify({
        password: formData.get("password"),
        username: formData.get("username")
      })
    });
    window.location.href = data.redirectTo || "/admin";
  } catch (error) {
    adminSetupStatus.textContent = error.message;
  } finally {
    adminSetupSubmit.disabled = false;
  }
});

loadSetupState().catch((error) => {
  adminSetupStatus.textContent = error.message;
});
