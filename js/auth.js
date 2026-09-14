(function () {
  "use strict";

  const db = window.P21_DB;
  const gate = document.getElementById("loginGate");
  const main = document.getElementById("cabinaMain");
  const form = document.getElementById("loginForm");
  const msg = document.getElementById("loginMsg");
  const btnLogout = document.getElementById("btnLogout");

  const MAX_INTENTOS = 5;

  if (!db || !db.auth) {
    console.error("auth.js: no hay cliente Supabase con auth");
    if (msg) msg.textContent = "❌ No se pudo conectar con Supabase.";
    return;
  }

  async function refresh() {
    try {
      const { data } = await db.auth.getSession();
      const logged = !!(data && data.session);
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
      const btnEntrar = form.querySelector('button[type="submit"]');

      if (msg) { msg.textContent = "⏳ Verificando..."; msg.classList.remove("error"); }
      if (btnEntrar) btnEntrar.disabled = true;

      try {
        // 1) ¿Está bloqueada esta cuenta por intentos fallidos previos?
        const { data: estado, error: eEstado } = await db.rpc("puede_intentar", { p_email: email });
        if (eEstado) throw eEstado;

        const info = Array.isArray(estado) ? estado[0] : estado;
        if (info && info.permitido === false) {
          if (msg) msg.textContent = `🔒 Cuenta bloqueada temporalmente. Intenta de nuevo en ${info.minutos_restantes} min.`;
          return;
        }

        // 2) Intentar el login real contra Supabase Auth
        const { data, error } = await db.auth.signInWithPassword({ email, password: pass });

        if (error) {
          // 3) Registrar el intento fallido y avisar cuántos quedan
          const { data: conteo } = await db.rpc("registrar_intento_fallido", { p_email: email });
          const restantes = Math.max(0, MAX_INTENTOS - (conteo || 0));
          if (msg) {
            msg.textContent = restantes > 0
              ? `❌ Acceso denegado. Te quedan ${restantes} intento(s).`
              : "🔒 Demasiados intentos fallidos. Cuenta bloqueada 15 minutos.";
          }
        } else {
          // 4) Login correcto: limpiar el contador de intentos
          await db.rpc("limpiar_intentos", { p_email: email });
          console.log("auth.js: sesión iniciada para:", data.user && data.user.email);
          if (msg) msg.textContent = "✅ Bienvenido, Profechan.";
          form.reset();
          await refresh();
        }
      } catch (err) {
        console.error("auth.js: excepción:", err);
        if (msg) msg.textContent = "❌ Error de conexión: " + err.message;
      } finally {
        if (btnEntrar) btnEntrar.disabled = false;
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
