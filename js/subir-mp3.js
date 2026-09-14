(function () {
  "use strict";

  const db = window.P21_DB;
  if (!db) return;

  const $ = (id) => document.getElementById(id);

  const inputAudio = $("audioFile");
  const btnSubir = $("btnSubirEpisodio");
  const nombreAudio = $("audioNombre");

  if (!inputAudio || !btnSubir) return;

  inputAudio.addEventListener("change", () => {
    const f = inputAudio.files[0];
    if (nombreAudio) {
      nombreAudio.textContent = f ? "🎧 " + f.name : "Sin audio elegido (para subir episodio)";
    }
  });

  btnSubir.addEventListener("click", subirEpisodioMP3);

  // Sube un archivo al Worker (que a su vez lo guarda en Backblaze B2)
  // y devuelve su URL pública. folder: "audios" o "portadas"
  async function subirArchivo(file, folder) {
    const { data: sesion } = await db.auth.getSession();
    const token = sesion && sesion.session && sesion.session.access_token;
    if (!token) throw new Error("Debes iniciar sesión para subir archivos.");

    const resp = await fetch(`${window.B2_WORKER_URL}/upload`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": file.type || "application/octet-stream",
        "X-Filename": file.name,
        "X-Folder": folder,
      },
      body: file,
    });

    if (!resp.ok) {
      const err = await resp.json().catch(() => ({}));
      throw new Error(err.error || `Error al subir archivo (${resp.status})`);
    }
    const { url } = await resp.json();
    return url;
  }

  async function subirEpisodioMP3() {
    const f = inputAudio.files[0];
    const titulo = $("titulo").value.trim();
    const estado = $("estadoGrabacion");

    if (!titulo) { alert("Escribe un título para el episodio."); return; }
    if (!f) { alert("Elige primero el archivo de audio MP3."); return; }

    btnSubir.disabled = true;
    if (estado) { estado.textContent = "📤 Subiendo episodio con portada..."; estado.classList.remove("error"); }

    try {
      const dur = await duracionDeArchivo(f);

      // 1) Subir el audio (a B2, vía el Worker)
      const urlAudio = await subirArchivo(f, "audios");

      // 2) Subir la portada (opcional, también a B2)
      let urlImagen = "";
      let avisoImg = "";
      const img = $("imagen").files[0];
      if (img) {
        try {
          urlImagen = await subirArchivo(img, "portadas");
        } catch (e2) {
          avisoImg = " ⚠️ Portada no subida: " + e2.message;
          console.error("Error de portada:", e2);
        }
      }

      // 3) Publicar el episodio (igual que antes, solo cambian las URLs)
      const { error: e3 } = await db.from("audios").insert({
        titulo: titulo,
        alumno: $("alumno").value.trim() || "Anónimo",
        descripcion: $("descripcion").value.trim(),
        categoria: $("categoria").value || "General",
        temporada: $("temporada").value.trim() || "Temporada 1 - 2026",
        destacado: $("destacado").checked,
        archivo: f.name,
        url: urlAudio,
        imagen: urlImagen,
        publicado: true,
        duracion: dur || 0
      });
      if (e3) throw new Error(e3.message);

      if (estado) estado.textContent = "✅ Episodio publicado." + avisoImg + " Recargando...";
      ["titulo", "alumno", "descripcion"].forEach(id => { const el = $(id); if (el) el.value = ""; });
      $("imagen").value = "";
      inputAudio.value = "";
      $("destacado").checked = false;

      setTimeout(() => location.reload(), 1500);
    } catch (e) {
      console.error(e);
      if (estado) { estado.textContent = "❌ Error al subir: " + e.message; estado.classList.add("error"); }
      btnSubir.disabled = false;
    }
  }

  function duracionDeArchivo(file) {
    return new Promise((resolve) => {
      const a = new Audio(URL.createObjectURL(file));
      a.addEventListener("loadedmetadata", () => resolve(Math.round(a.duration) || 0));
      a.addEventListener("error", () => resolve(0));
    });
  }
})();
