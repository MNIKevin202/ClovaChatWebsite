const form = document.querySelector("#authForm");
const title = document.querySelector("#authTitle");
const copy = document.querySelector("#authCopy");
const eyebrow = document.querySelector("#authEyebrow");
const statusText = document.querySelector("#authStatus");
const submitButton = document.querySelector("#authSubmit");
const passwordInput = document.querySelector("#password");

let setupMode = false;

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

async function loadAuthState() {
  const state = await requestJson("/api/auth/status");
  if (state.authenticated) {
    window.location.href = "/admin";
    return;
  }
  setupMode = !state.adminExists;
  if (setupMode) {
    eyebrow.textContent = "FIRST RUN";
    title.textContent = "Create the first admin.";
    copy.textContent = "No admin exists yet. Create the first account to lock down the site.";
    submitButton.textContent = "Create Admin";
    passwordInput.autocomplete = "new-password";
  }
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  statusText.textContent = "";
  submitButton.disabled = true;
  const formData = new FormData(form);
  try {
    await requestJson(setupMode ? "/api/auth/setup" : "/api/auth/login", {
      method: "POST",
      body: JSON.stringify({
        password: formData.get("password"),
        username: formData.get("username")
      })
    });
    window.location.href = "/admin";
  } catch (error) {
    statusText.textContent = error.message;
  } finally {
    submitButton.disabled = false;
  }
});

loadAuthState().catch((error) => {
  statusText.textContent = error.message;
});
