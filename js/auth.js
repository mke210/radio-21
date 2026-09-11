(function () {
  "use strict";

  const db = window.P21_DB;
  const gate = document.getElementById("loginGate");
  const main = document.getElementById("cabinaMain");
  const form = document.getElementById("loginForm");
  const msg = document.getElementById("loginMsg");
  const btnLogout = document.getElementById("btnLogout");

  if (!db || !db.auth) {
    console.error("auth.js: no hay cliente Supabase con auth");
    if (msg) msg.textContent = "❌ No se pudo conectar con Supabase.";
    return;
  }

  async function refresh() {
    try {
      const { data } = await db.auth.getSession();
      const logged = !!(data && data.session);
      console.log("auth.js: ¿hay sesión? =", logged);
      if (gate) gate.style.display = logged ? "none" : "flex";
      if (main) main.style.display = logged ? "block" : "none";
      if (btnLogout) btnLogout.style.display = logged ? "inline-block" : "none";
    } catch (e) {
      console.error("auth.js: error de sesión", e);
    }
  }

  if (form) {
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const email = document.getElementById("loginEmail").value.trim();
      const pass = document.getElementById("loginPassword").value;

      if (msg) msg.textContent = "⏳ Verificando...";
      console.log("auth.js: intentando entrar con:", email);

      try {
        const { data, error } = await db.auth.signInWithPassword({ email, password: pass });

        if (error) {
          console.error("auth.js: Supabase respondió:", error.message);
          if (msg) msg.textContent = "❌ Acceso denegado: " + error.message;
        } else {
          console.log("auth.js: sesión iniciada para:", data.user && data.user.email);
          if (msg) msg.textContent = "✅ Bienvenido, Profechan.";
          form.reset();
          await refresh();
        }
      } catch (err) {
        console.error("auth.js: excepción:", err);
        if (msg) msg.textContent = "❌ Error de conexión: " + err.message;
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
