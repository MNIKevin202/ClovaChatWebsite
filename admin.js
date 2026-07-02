const adminCopy = document.querySelector("#adminCopy");
const adminUsername = document.querySelector("#adminUsername");
const logoutButton = document.querySelector("#logoutButton");

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

async function loadAdmin() {
  try {
    const data = await requestJson("/api/admin/me");
    adminUsername.textContent = data.user.username;
    adminCopy.textContent = "Admin access is active. More management tools can be added here.";
  } catch {
    window.location.href = "/login";
  }
}

logoutButton.addEventListener("click", async () => {
  await requestJson("/api/auth/logout", { method: "POST", body: "{}" });
  window.location.href = "/login";
});

loadAdmin();
