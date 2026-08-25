(function () {
  "use strict";

  const db = window.P21_DB;
  if (!db || !db.auth) return;

  const gate = document.getElementById("loginGate");
  const main = document.getElementById("cabinaMain");
  const form = document.getElementById("loginForm");
  const msg = document.getElementById("loginMsg");
  const btnLogout = document.getElementById("btnLogout");

  async function refresh() {
    const { data } = await db.auth.getSession();
    const logged = !!(data && data.session);

    if (gate) gate.style.display = logged ? "none" : "flex";
    if (main) main.style.display = logged ? "block" : "none";
    if (btnLogout) btnLogout.style.display = logged ? "inline-block" : "none";
  }

  if (form) {
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const email = document.getElementById("loginEmail").value.trim();
      const pass = document.getElementById("loginPassword").value;

      const { error } = await db.auth.signInWithPassword({ email, password });

      if (error) {
        msg.textContent = "❌ Acceso denegado: " + error.message;
      } else {
        msg.textContent = "";
        form.reset();
        refresh();
      }
    });
  }

  if (btnLogout) {
    btnLogout.addEventListener("click", async () => {
      await db.auth.signOut();
      refresh();
    });
  }

  refresh();
})();