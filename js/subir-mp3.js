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
      const ext = extensionDesdeNombre(f.name);
      const archivo = `${Date.now()}-${slug(titulo)}.${ext}`;

      // 1) Subir el audio
      const bucketAudios = db.storage.from("audios");
      const { error: e1 } = await bucketAudios.upload(archivo, f, {
        contentType: f.type || "audio/mpeg",
        upsert: false
      });
      if (e1) throw new Error(e1.message);
      const urlAudio = bucketAudios.getPublicUrl(archivo).data.publicUrl;

      // 2) Subir la portada (ahora con aviso si falla)
      let urlImagen = "";
      let avisoImg = "";
      const img = $("imagen").files[0];
      if (img) {
        const nombreImg = `${Date.now()}-${slug(titulo)}.jpg`;
        const bucketImg = db.storage.from("imagenes");
        const { error: e2 } = await bucketImg.upload(nombreImg, img, { contentType: img.type });
        if (e2) {
          avisoImg = " ⚠️ Portada no subida: " + e2.message;
          console.error("Error de portada:", e2);
        } else {
          urlImagen = bucketImg.getPublicUrl(nombreImg).data.publicUrl;
        }
      }

      // 3) Publicar el episodio
      const { error: e3 } = await db.from("audios").insert({
        titulo: titulo,
        alumno: $("alumno").value.trim() || "Anónimo",
        descripcion: $("descripcion").value.trim(),
        categoria: $("categoria").value || "General",
        temporada: $("temporada").value.trim() || "Temporada 1 - 2026",
        destacado: $("destacado").checked,
        archivo: archivo,
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

  function extensionDesdeNombre(n) {
    const m = n.match(/\.([a-z0-9]+)$/i);
    return m ? m[1].toLowerCase() : "mp3";
  }

  function slug(t) {
    return t.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "audio";
  }
})();