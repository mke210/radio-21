(function () {
  "use strict";

  const config = { url: window.SUPABASE_URL, key: window.SUPABASE_ANON_KEY };
  if (!window.supabase || !config.url || config.url.includes("PEGAR")) return;

  const db = window.supabase.createClient(config.url, config.key);

  // Crear toast si no existe
  let toast = document.getElementById("toast");
  if (!toast) {
    toast = document.createElement("div");
    toast.id = "toast";
    toast.className = "toast";
    document.body.appendChild(toast);
  }

  function mostrarToast(html) {
    toast.innerHTML = html;
    toast.classList.add("visible");
    setTimeout(() => toast.classList.remove("visible"), 6000);
  }

  async function revisarNuevo() {
    const { data, error } = await db
      .from("audios")
      .select("id,titulo")
      .eq("publicado", true)
      .order("creado_en", { ascending: false })
      .limit(1);

    if (error || !data || !data.length) return;

    const ultimo = data[0];
    const guardado = localStorage.getItem("p21_last_ep");

    if (!guardado) {
      localStorage.setItem("p21_last_ep", ultimo.id);
      return;
    }

    if (guardado !== ultimo.id) {
      localStorage.setItem("p21_last_ep", ultimo.id);
      mostrarToast(`🔔 <strong>Nuevo episodio:</strong> ${ultimo.titulo}`);

      if ("Notification" in window && Notification.permission === "granted") {
        new Notification("Podcast 21 🎙️", {
          body: `Nuevo episodio: ${ultimo.titulo}`
        });
      }
    }
  }

  // Botón campanita
  const btnBell = document.getElementById("btnNotificaciones");
  if (btnBell) {
    if (!("Notification" in window)) {
      btnBell.style.display = "none";
    } else {
      btnBell.addEventListener("click", async () => {
        const perm = await Notification.requestPermission();
        mostrarToast(
          perm === "granted"
            ? "🔔 Notificaciones del navegador activadas."
            : "⚠️ No se activaron las notificaciones."
        );
      });
    }
  }

  revisarNuevo();
  setInterval(revisarNuevo, 30000);
})();