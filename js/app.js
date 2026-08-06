(function () {
  "use strict";

  const $ = (id) => document.getElementById(id);

  // Adjunta eventos de forma segura: si un elemento no existe, no rompe todo.
  function on(id, evento, fn) {
    const el = $(id);
    if (el) el.addEventListener(evento, fn);
    else console.warn("cabina: falta el elemento #" + id);
  }

  const config = {
    url: window.SUPABASE_URL,
    key: window.SUPABASE_ANON_KEY,
    room: window.JITSI_ROOM || "Cabina21DeNoviembre"
  };

  const configOk =
    config.url && !config.url.includes("PEGAR") &&
    config.key && !config.key.includes("PEGAR");

  let db = null;

  if (!window.supabase) {
    console.error("cabina: no se cargó la librería de Supabase.");
  } else if (!configOk) {
    console.error("cabina: falta configurar js/config.js");
  } else {
    db = window.supabase.createClient(config.url, config.key);
  }

  let audios = [];
  let playlist = [];
  let indice = 0;
  let loopActivo = false;

  let mediaRecorder = null;
  let audioChunks = [];
  let streamActual = null;

  // Sala en vivo
  const frame = $("jitsiFrame");
  if (frame) frame.src = "https://meet.jit.si/" + encodeURIComponent(config.room);

  // Eventos (siempre se adjuntan, aunque falle Supabase)
  on("btnGrabar", "click", iniciarGrabacion);
  on("btnDetener", "click", detenerGrabacion);
  on("btnLoop", "click", reproducirLoop);
  on("btnStop", "click", detenerReproduccion);
  on("btnActualizar", "click", () => cargarAudios());
  on("editForm", "submit", guardarEdicion);
  on("btnCancelarEditar", "click", () => {
    const modal = $("editModal");
    if (modal) modal.close();
  });
  on("reproductor", "ended", siguienteSiLoop);

  cargarAudios();

  // ======================================================
  // GRABACIÓN
  // ======================================================

  async function iniciarGrabacion() {
    const titulo = $("titulo").value.trim();

    if (!titulo) {
      estadoGrabacion("Escribe un título antes de grabar.", true);
      return;
    }

    if (!db) {
      estadoGrabacion("Falta configurar Supabase en js/config.js.", true);
      return;
    }

    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      estadoGrabacion(
        "Este navegador no permite usar el micrófono aquí. Abre la página con HTTPS (GitHub Pages) o localhost.",
        true
      );
      return;
    }

    setGrabandoUI(true);
    estadoGrabacion("Pidiendo permiso de micrófono…");

    try {
      streamActual = await navigator.mediaDevices.getUserMedia({ audio: true });

      const options = {};

      if (MediaRecorder.isTypeSupported("audio/webm;codecs=opus")) {
        options.mimeType = "audio/webm;codecs=opus";
      } else if (MediaRecorder.isTypeSupported("audio/mp4")) {
        options.mimeType = "audio/mp4";
      }

      audioChunks = [];

      mediaRecorder = new MediaRecorder(streamActual, options);

      mediaRecorder.ondataavailable = (event) => {
        if (event.data.size > 0) audioChunks.push(event.data);
      };

      mediaRecorder.onstop = async () => {
        if (streamActual) {
          streamActual.getTracks().forEach((track) => track.stop());
        }

        estadoGrabacion("Subiendo y guardando episodio…");

        const blob = new Blob(audioChunks, {
          type: mediaRecorder.mimeType || "audio/webm"
        });

        await subirAudio(blob);

        setGrabandoUI(false);
      };

      mediaRecorder.start();

      estadoGrabacion("Grabando… haz clic en Detener cuando termines.");
    } catch (error) {
      console.error(error);
      setGrabandoUI(false);

      if (error && error.name === "NotAllowedError") {
        estadoGrabacion("Permiso de micrófono denegado. Actívalo en el navegador.", true);
      } else if (error && error.name === "NotFoundError") {
        estadoGrabacion("No se encontró ningún micrófono conectado.", true);
      } else {
        estadoGrabacion("No se pudo abrir el micrófono.", true);
      }
    }
  }

  function detenerGrabacion() {
    if (mediaRecorder && mediaRecorder.state !== "inactive") {
      mediaRecorder.stop();
    }
  }

  function setGrabandoUI(grabando) {
    const btnGrabar = $("btnGrabar");
    const btnDetener = $("btnDetener");

    if (btnGrabar) {
      btnGrabar.disabled = grabando;
      btnGrabar.classList.toggle("recording", grabando);
    }

    if (btnDetener) btnDetener.disabled = !grabando;
  }

  async function subirAudio(blob) {
    try {
      const titulo = $("titulo").value.trim();
      const alumno = $("alumno").value.trim() || "Anónimo";
      const descripcion = $("descripcion").value.trim();

      if (!titulo) {
        estadoGrabacion("Falta el título.", true);
        return;
      }

      const extension = extensionDesdeBlob(blob);
      const archivo = `${Date.now()}-${slug(titulo)}.${extension}`;

      const { error: errorUpload } = await db.storage
        .from("audios")
        .upload(archivo, blob, {
          contentType: blob.type || "audio/webm",
          upsert: false
        });

      if (errorUpload) {
        console.error(errorUpload);
        estadoGrabacion("Error al subir el archivo de audio.", true);
        return;
      }

      const { data: urlData } = db.storage.from("audios").getPublicUrl(archivo);

      const { error: errorInsert } = await db.from("audios").insert({
        titulo,
        alumno,
        descripcion,
        archivo,
        url: urlData.publicUrl,
        publicado: true
      });

      if (errorInsert) {
        console.error(errorInsert);
        estadoGrabacion("Error al guardar en la base de datos.", true);
        return;
      }

      estadoGrabacion("Episodio guardado correctamente.");

      $("titulo").value = "";
      $("alumno").value = "";
      $("descripcion").value = "";

      await cargarAudios();
    } catch (error) {
      console.error(error);
      estadoGrabacion("Ocurrió un error al guardar el episodio.", true);
    }
  }

  // ======================================================
  // CARGAR Y MOSTRAR
  // ======================================================

  async function cargarAudios() {
    if (!db) {
      const tbody = $("tablaAudios");
      if (tbody) {
        tbody.innerHTML =
          "<tr><td colspan='4'>Configura js/config.js con tus datos de Supabase.</td></tr>";
      }
      return;
    }

    const { data, error } = await db
      .from("audios")
      .select("*")
      .order("creado_en", { ascending: false });

    if (error) {
      console.error(error);
      estadoGrabacion("Error al cargar episodios: " + error.message, true);
      return;
    }

    audios = data || [];

    renderLoop();
    renderTabla();
  }

  function renderLoop() {
    const loopList = $("loopList");
    if (!loopList) return;

    loopList.innerHTML = "";

    const latest = audios.slice(0, 3);

    if (!latest.length) {
      loopList.innerHTML = "<p class='small'>No hay audios guardados todavía.</p>";
      return;
    }

    latest.forEach((item, index) => {
      const div = document.createElement("div");
      div.className = "audio-item";
      div.textContent = `${index + 1}. ${item.titulo} — ${item.alumno || "Anónimo"}`;
      loopList.appendChild(div);
    });
  }

  function renderTabla() {
    const tbody = $("tablaAudios");
    if (!tbody) return;

    tbody.innerHTML = "";

    if (!audios.length) {
      tbody.innerHTML =
        "<tr><td colspan='4'>No hay episodios guardados.</td></tr>";
      return;
    }

    audios.forEach((item) => {
      const publicado = item.publicado !== false;

      const tr = document.createElement("tr");

      const tdTitulo = document.createElement("td");
      tdTitulo.textContent = item.titulo;

      const tdAlumno = document.createElement("td");
      tdAlumno.textContent = item.alumno || "Anónimo";

      const tdEstado = document.createElement("td");
      const badge = document.createElement("span");
      badge.className = "badge " + (publicado ? "badge-on" : "badge-off");
      badge.textContent = publicado ? "Publicado" : "Oculto";
      tdEstado.appendChild(badge);

      const tdAcciones = document.createElement("td");
      const acciones = document.createElement("div");
      acciones.className = "acciones";

      const btnEscuchar = document.createElement("button");
      btnEscuchar.textContent = "Escuchar";
      btnEscuchar.className = "btn btn-mini btn-blue";
      btnEscuchar.onclick = () => reproducirUno(item.id);

      const btnEditar = document.createElement("button");
      btnEditar.textContent = "Editar";
      btnEditar.className = "btn btn-mini btn-edit";
      btnEditar.onclick = () => abrirEditar(item.id);

      const btnPublicar = document.createElement("button");
      btnPublicar.textContent = publicado ? "Ocultar" : "Publicar";
      btnPublicar.className = "btn btn-mini " + (publicado ? "btn-hide" : "btn-pub");
      btnPublicar.onclick = () => togglePublicar(item.id);

      const btnBorrar = document.createElement("button");
      btnBorrar.textContent = "Borrar";
      btnBorrar.className = "btn btn-mini btn-del";
      btnBorrar.onclick = () => borrarAudio(item.id);

      acciones.appendChild(btnEscuchar);
      acciones.appendChild(btnEditar);
      acciones.appendChild(btnPublicar);
      acciones.appendChild(btnBorrar);
      tdAcciones.appendChild(acciones);

      tr.appendChild(tdTitulo);
      tr.appendChild(tdAlumno);
      tr.appendChild(tdEstado);
      tr.appendChild(tdAcciones);

      tbody.appendChild(tr);
    });
  }

  // ======================================================
  // REPRODUCCIÓN
  // ======================================================

  function reproducirUno(id) {
    const item = audios.find((audio) => audio.id === id);
    if (!item) return;

    loopActivo = false;

    const reproductor = $("reproductor");
    reproductor.src = item.url;
    reproductor.play().catch(() => {
      estadoReproduccion("Pulsa el botón de reproducción del audio.", true);
    });

    estadoReproduccion(`Reproduciendo: ${item.titulo}`);
  }

  function reproducirLoop() {
    playlist = audios.slice(0, 3);

    if (!playlist.length) {
      estadoReproduccion("No hay audios para reproducir en loop.", true);
      return;
    }

    loopActivo = true;
    indice = 0;
    reproducirActual();
  }

  function reproducirActual() {
    const item = playlist[indice];
    if (!item) return;

    const reproductor = $("reproductor");
    reproductor.src = item.url;
    reproductor.play().catch(() => {
      estadoReproduccion("Pulsa el botón de reproducción del audio.", true);
    });

    estadoReproduccion(`Loop reproduciendo: ${item.titulo}`);
  }

  function siguienteSiLoop() {
    if (loopActivo && playlist.length > 0) {
      indice = (indice + 1) % playlist.length;
      reproducirActual();
    }
  }

  function detenerReproduccion() {
    loopActivo = false;

    const reproductor = $("reproductor");
    reproductor.pause();
    reproductor.removeAttribute("src");
    reproductor.load();

    estadoReproduccion("Reproducción detenida.");
  }

  // ======================================================
  // EDITAR / PUBLICAR / BORRAR
  // ======================================================

  function abrirEditar(id) {
    const item = audios.find((audio) => audio.id === id);
    if (!item) return;

    $("editId").value = item.id;
    $("editTitulo").value = item.titulo;
    $("editAlumno").value = item.alumno || "";
    $("editDescripcion").value = item.descripcion || "";

    $("editModal").showModal();
  }

  async function guardarEdicion(event) {
    event.preventDefault();

    const id = $("editId").value;
    const titulo = $("editTitulo").value.trim();
    const alumno = $("editAlumno").value.trim() || "Anónimo";
    const descripcion = $("editDescripcion").value.trim();

    if (!titulo) {
      alert("El título no puede estar vacío.");
      return;
    }

    const { error } = await db
      .from("audios")
      .update({ titulo, alumno, descripcion })
      .eq("id", id);

    if (error) {
      console.error(error);
      alert("Error al editar: " + error.message);
      return;
    }

    $("editModal").close();
    await cargarAudios();
  }

  async function togglePublicar(id) {
    const item = audios.find((audio) => audio.id === id);
    if (!item) return;

    const nuevoEstado = !(item.publicado !== false);

    const { error } = await db
      .from("audios")
      .update({ publicado: nuevoEstado })
      .eq("id", id);

    if (error) {
      console.error(error);
      alert("Error al cambiar el estado: " + error.message);
      return;
    }

    await cargarAudios();
  }

  async function borrarAudio(id) {
    const item = audios.find((audio) => audio.id === id);
    if (!item) return;

    if (!confirm(`¿Seguro que quieres borrar "${item.titulo}"?`)) return;

    if (item.archivo) {
      const { error: errorArchivo } = await db.storage
        .from("audios")
        .remove([item.archivo]);

      if (errorArchivo) console.error("Error borrando archivo:", errorArchivo);
    }

    const { error } = await db.from("audios").delete().eq("id", id);

    if (error) {
      console.error(error);
      alert("Error al borrar: " + error.message);
      return;
    }

    detenerReproduccion();
    await cargarAudios();
  }

  // ======================================================
  // UTILIDADES
  // ======================================================

  function estadoGrabacion(texto, esError) {
    const el = $("estadoGrabacion");
    if (!el) return;
    el.textContent = texto;
    el.classList.toggle("error", !!esError);
  }

  function estadoReproduccion(texto, esError) {
    const el = $("estadoReproduccion");
    if (!el) return;
    el.textContent = texto;
    el.classList.toggle("error", !!esError);
  }

  function slug(texto) {
    return (
      texto
        .toLowerCase()
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "") || "audio"
    );
  }

  function extensionDesdeBlob(blob) {
    if (!blob || !blob.type) return "webm";
    if (blob.type.includes("mp4")) return "mp4";
    if (blob.type.includes("ogg")) return "ogg";
    if (blob.type.includes("mpeg")) return "mp3";
    return "webm";
  }
})();