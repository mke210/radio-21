(function () {
  "use strict";

  // Registrar el service worker
  if ("serviceWorker" in navigator) {
    window.addEventListener("load", () => {
      navigator.serviceWorker.register("sw.js").catch(() => {});
    });
  }

  // Botón 📲 (aparece solo si el navegador permite instalar)
  let deferred = null;
  const btn = document.getElementById("btnInstalar");

  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault();
    deferred = e;
    if (btn) btn.classList.remove("oculto");
  });

  if (btn) {
    btn.addEventListener("click", async () => {
      if (!deferred) return;
      deferred.prompt();
      await deferred.userChoice;
      deferred = null;
      btn.classList.add("oculto");
    });
  }

  window.addEventListener("appinstalled", () => {
    if (btn) btn.classList.add("oculto");
  });
})();