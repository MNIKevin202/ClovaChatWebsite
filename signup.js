const signupForm = document.querySelector("#signupForm");
const signupStatus = document.querySelector("#signupStatus");
const signupSubmit = document.querySelector("#signupSubmit");

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

async function loadSignupState() {
  const state = await requestJson("/api/auth/status");
  if (state.authenticated) {
    window.location.href = state.redirectTo || (state.user?.role === "admin" ? "/admin" : "/account");
  }
}

signupForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  signupStatus.textContent = "";
  signupSubmit.disabled = true;
  const formData = new FormData(signupForm);
  try {
    await requestJson("/api/auth/register", {
      method: "POST",
      body: JSON.stringify({
        password: formData.get("password"),
        username: formData.get("username")
      })
    });
    window.location.href = data.redirectTo || "/account";
  } catch (error) {
    signupStatus.textContent = error.message;
  } finally {
    signupSubmit.disabled = false;
  }
});

loadSignupState().catch((error) => {
  signupStatus.textContent = error.message;
});
