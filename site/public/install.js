let installPrompt = null;
const installButton = document.getElementById("install-app");

window.addEventListener("beforeinstallprompt", (event) => {
    event.preventDefault();
    installPrompt = event;
    installButton.hidden = false;
});

installButton.addEventListener("click", async () => {
    if (!installPrompt) return;
    installPrompt.prompt();
    const choice = await installPrompt.userChoice;
    if (choice.outcome === "accepted") installButton.hidden = true;
    installPrompt = null;
});

window.addEventListener("appinstalled", () => {
    installPrompt = null;
    installButton.hidden = true;
});
