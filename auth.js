const form = document.querySelector("#authForm");
const statusText = document.querySelector("#authStatus");
const submitButton = document.querySelector("#authSubmit");

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

async function loadAuthState() {
  const state = await requestJson("/api/auth/status");
  if (state.authenticated) {
    window.location.href = destinationFor(state.user);
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
        username: formData.get("username")
      })
    });
    window.location.href = destinationFor(data.user);
  } catch (error) {
    statusText.textContent = error.message;
  } finally {
    submitButton.disabled = false;
  }
});

loadAuthState().catch((error) => {
  statusText.textContent = error.message;
});
