(function () {
  const config = {
    url: window.SUPABASE_URL,
    key: window.SUPABASE_ANON_KEY,
    room: window.JITSI_ROOM || "Cabina21DeNoviembre"
  };

  if (!window.supabase) {
    alert("No se cargó la librería de Supabase. Revisa tu conexión o el script CDN.");
    return;
  }

  if (
    !config.url ||
    config.url.includes("PEGAR") ||
    !config.key ||
    config.key.includes("PEGAR")
  ) {
    alert("Configura primero js/config.js con tu URL y anon key de Supabase.");
    return;
  }

  const { createClient } = window.supabase;
  const db = createClient(config.url, config.key);

  let audios = [];
  let playlist = [];
  let indice = 0;
  let loopActivo = false;

  let mediaRecorder = null;
  let audioChunks = [];
  let streamActual = null;

  const $ = (id) => document.getElementById(id);

  init();

  function init() {
    $("jitsiFrame").src = `https://meet.jit.si/${encodeURIComponent(config.room)}`;

    $("btnGrabar").addEventListener("click", iniciarGrabacion);
    $("btnDetener").addEventListener("click", detenerGrabacion);

    $("btnLoop").addEventListener("click", reproducirLoop);
    $("btnStop").addEventListener("click", detenerReproduccion);

    $("btnActualizar").addEventListener("click", cargarAudios);

    $("editForm").addEventListener("submit", guardarEdicion);
    $("btnCancelarEditar").addEventListener("click", () => {
      $("editModal").close();
    });

    $("reproductor").addEventListener("ended", siguienteSiLoop);

    cargarAudios();
  }

  // ======================================================
  // GRABACIÓN
  // ======================================================

  async function iniciarGrabacion() {
    const titulo = $("titulo").value.trim();

    if (!titulo) {
      estadoGrabacion("Escribe un título antes de grabar.");
      return;
    }

    $("btnGrabar").disabled = true;
    $("btnDetener").disabled = false;
    estadoGrabacion("Pidiendo permiso de micrófono...");

    try {
      streamActual = await navigator.mediaDevices.getUserMedia({
        audio: true
      });

      const options = {};

      if (MediaRecorder.isTypeSupported("audio/webm;codecs=opus")) {
        options.mimeType = "audio/webm;codecs=opus";
      } else if (MediaRecorder.isTypeSupported("audio/mp4")) {
        options.mimeType = "audio/mp4";
      }

      audioChunks = [];

      mediaRecorder = new MediaRecorder(streamActual, options);

      mediaRecorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          audioChunks.push(event.data);
        }
      };

      mediaRecorder.onstop = async () => {
        if (streamActual) {
          streamActual.getTracks().forEach((track) => track.stop());
        }

        estadoGrabacion("Subiendo y guardando audio...");

        const blob = new Blob(audioChunks, {
          type: mediaRecorder.mimeType || "audio/webm"
        });

        await subirAudio(blob);

        $("btnGrabar").disabled = false;
        $("btnDetener").disabled = true;
      };

      mediaRecorder.start();

      estadoGrabacion("Grabando... haz clic en Detener cuando termines.");
    } catch (error) {
      console.error(error);
      estadoGrabacion("No se pudo acceder al micrófono.");
      $("btnGrabar").disabled = false;
      $("btnDetener").disabled = true;
    }
  }

  function detenerGrabacion() {
    if (mediaRecorder && mediaRecorder.state !== "inactive") {
      mediaRecorder.stop();
    }
  }

  async function subirAudio(blob) {
    try {
      const titulo = $("titulo").value.trim();
      const alumno = $("alumno").value.trim() || "Anónimo";
      const descripcion = $("descripcion").value.trim();

      if (!titulo) {
        estadoGrabacion("Falta el título.");
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
        estadoGrabacion("Error al subir el archivo de audio.");
        return;
      }

      const { data: urlData, error: urlError } = db.storage
        .from("audios")
        .getPublicUrl(archivo);

      if (urlError) {
        console.error(urlError);
        estadoGrabacion("Error al obtener la URL pública del audio.");
        return;
      }

      const urlPublica = urlData.publicUrl;

      const { error: errorInsert } = await db.from("audios").insert({
        titulo,
        alumno,
        descripcion,
        archivo,
        url: urlPublica,
        publicado: true
      });

      if (errorInsert) {
        console.error(errorInsert);
        estadoGrabacion("Error al guardar en la base de datos.");
        return;
      }

      estadoGrabacion("Episodio guardado correctamente.");

      $("titulo").value = "";
      $("alumno").value = "";
      $("descripcion").value = "";

      await cargarAudios();
    } catch (error) {
      console.error(error);
      estadoGrabacion("Ocurrió un error al guardar el audio.");
    }
  }

  // ======================================================
  // CARGAR AUDIOS
  // ======================================================

  async function cargarAudios() {
    const { data, error } = await db
      .from("audios")
      .select("*")
      .order("creado_en", { ascending: false });

    if (error) {
      console.error(error);
      alert("Error al cargar audios: " + error.message);
      return;
    }

    audios = data || [];

    renderLoop();
    renderTabla();
  }

  function renderLoop() {
    const loopList = $("loopList");
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
    tbody.innerHTML = "";

    if (!audios.length) {
      const tr = document.createElement("tr");
      const td = document.createElement("td");
      td.colSpan = 4;
      td.textContent = "No hay episodios guardados.";
      tr.appendChild(td);
      tbody.appendChild(tr);
      return;
    }

    audios.forEach((item) => {
      const tr = document.createElement("tr");

      const tdTitulo = document.createElement("td");
      tdTitulo.textContent = item.titulo;

      const tdAlumno = document.createElement("td");
      tdAlumno.textContent = item.alumno || "Anónimo";

      const tdEstado = document.createElement("td");
      tdEstado.textContent = item.publicado ? "Publicado" : "Oculto";

      const tdAcciones = document.createElement("td");
      const acciones = document.createElement("div");
      acciones.className = "acciones";

      const btnEscuchar = document.createElement("button");
      btnEscuchar.textContent = "Escuchar";
      btnEscuchar.onclick = () => reproducirUno(item.id);

      const btnEditar = document.createElement("button");
      btnEditar.textContent = "Editar";
      btnEditar.onclick = () => abrirEditar(item.id);

      const btnPublicar = document.createElement("button");
      btnPublicar.textContent = item.publicado ? "Ocultar" : "Publicar";
      btnPublicar.onclick = () => togglePublicar(item.id);

      const btnBorrar = document.createElement("button");
      btnBorrar.textContent = "Borrar";
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
    reproductor.play().catch((error) => {
      console.error(error);
      estadoReproduccion("No se pudo reproducir automáticamente.");
    });

    estadoReproduccion(`Reproduciendo: ${item.titulo}`);
  }

  function reproducirLoop() {
    playlist = audios.slice(0, 3);

    if (!playlist.length) {
      estadoReproduccion("No hay audios para reproducir en loop.");
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
    reproductor.play().catch((error) => {
      console.error(error);
      estadoReproduccion("No se pudo reproducir automáticamente.");
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
  // EDITAR
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
      .update({
        titulo,
        alumno,
        descripcion
      })
      .eq("id", id);

    if (error) {
      console.error(error);
      alert("Error al editar: " + error.message);
      return;
    }

    $("editModal").close();

    await cargarAudios();
  }

  // ======================================================
  // PUBLICAR / OCULTAR
  // ======================================================

  async function togglePublicar(id) {
    const item = audios.find((audio) => audio.id === id);

    if (!item) return;

    const nuevoEstado = !item.publicado;

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

  // ======================================================
  // BORRAR
  // ======================================================

  async function borrarAudio(id) {
    const item = audios.find((audio) => audio.id === id);

    if (!item) return;

    const confirmado = confirm(`¿Seguro que quieres borrar "${item.titulo}"?`);

    if (!confirmado) return;

    if (item.archivo) {
      const { error: errorArchivo } = await db.storage
        .from("audios")
        .remove([item.archivo]);

      if (errorArchivo) {
        console.error("Error borrando archivo:", errorArchivo);
      }
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

  function estadoGrabacion(texto) {
    $("estadoGrabacion").textContent = texto;
  }

  function estadoReproduccion(texto) {
    $("estadoReproduccion").textContent = texto;
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