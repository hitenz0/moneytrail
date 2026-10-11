// Apply the theme before the stylesheet paints, including on a saved-theme reload.
(() => {
    const key = "moneytrail-theme";
    const system = window.matchMedia("(prefers-color-scheme: dark)");
    let preference = null;
    try {
        const saved = localStorage.getItem(key);
        if (saved === "light" || saved === "dark") preference = saved;
    } catch {} // The switch still works when browser storage is unavailable.

    function apply() {
        const theme = preference || (system.matches ? "dark" : "light");
        document.documentElement.dataset.theme = theme;
        document.querySelectorAll("[data-theme-choice]").forEach((button) => {
            button.setAttribute("aria-pressed", String(button.dataset.themeChoice === theme));
        });
    }

    apply();
    system.addEventListener("change", () => { if (!preference) apply(); });
    document.addEventListener("DOMContentLoaded", () => {
        document.querySelectorAll("[data-theme-choice]").forEach((button) => {
            button.addEventListener("click", () => {
                preference = button.dataset.themeChoice;
                try { localStorage.setItem(key, preference); } catch {}
                apply();
            });
        });
        apply();
    });
})();
