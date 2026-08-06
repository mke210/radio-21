(function () {
  "use strict";

  const $ = (id) => document.getElementById(id);

  function on(id, evento, fn) {
    const el = $(id);
    if (el) el.addEventListener(evento, fn);
  }

  const config = {
    url: window.SUPABASE_URL,
    key: window.SUPABASE_ANON_KEY
  };

  const configOk =
    config.url && !config.url.includes("PEGAR") &&
    config.key && !config.key.includes("PEGAR");

  let db = null;

  if (!window.supabase) {
    console.error("No se cargó Supabase.");
  } else if (!configOk) {
    console.error("Falta configurar js/config.js");
  } else {
    db = window.supabase.createClient(config.url, config.key);
  }

  let audios = [];
  let playlist = [];
  let indice = 0;
  let loopActivo = false;

  // Estado para dos grabadores independientes
  const grabadores = {
    1: { mediaRecorder: null, audioChunks: [], stream: null, inicio: 0 },
    2: { mediaRecorder: null, audioChunks: [], stream: null, inicio: 0 }
  };

  // Eventos de grabación dual
  on("btnGrabar1", "click", () => iniciarGrabacion(1));
  on("btnDetener1", "click", () => detenerGrabacion(1));
  on("btnGrabar2", "click", () => iniciarGrabacion(2));
  on("btnDetener2", "click", () => detenerGrabacion(2));

  // Eventos de reproducción y administración
  on("btnLoop", "click", reproducirLoop);
  on("btnStop", "click", detenerReproduccion);
  on("btnActualizar", "click", cargarAudios);
  on("editForm", "submit", guardarEdicion);
  on("btnCancelarEditar", "click", () => $("editModal").close());
  on("reproductor", "ended", siguienteSiLoop);

  cargarAudios();

  // ======================================================
  // GRABACIÓN DUAL
  // ======================================================

  async function iniciarGrabacion(num) {
    const titulo = $(`titulo${num}`).value.trim();
    if (!titulo) { estadoGrabacion(num, "Escribe un título.", true); return; }
    if (!db) { estadoGrabacion(num, "Falta configurar Supabase.", true); return; }
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      estadoGrabacion(num, "Navegador no soporta micrófono aquí.", true); return;
    }

    setGrabandoUI(num, true);
    estadoGrabacion(num, "Pidiendo permiso de micrófono...");

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      grabadores[num].stream = stream;

      const options = {};
      if (MediaRecorder.isTypeSupported("audio/webm;codecs=opus")) {
        options.mimeType = "audio/webm;codecs=opus";
      } else if (MediaRecorder.isTypeSupported("audio/mp4")) {
        options.mimeType = "audio/mp4";
      }

      grabadores[num].audioChunks = [];
      grabadores[num].inicio = Date.now();

      const mediaRecorder = new MediaRecorder(stream, options);
      grabadores[num].mediaRecorder = mediaRecorder;

      mediaRecorder.ondataavailable = (e) => {
        if (e.data.size > 0) grabadores[num].audioChunks.push(e.data);
      };

      mediaRecorder.onstop = async () => {
        if (grabadores[num].stream) {
          grabadores[num].stream.getTracks().forEach(t => t.stop());
        }
        const duracionSeg = Math.round((Date.now() - grabadores[num].inicio) / 1000);
        estadoGrabacion(num, "Subiendo y guardando...");
        const blob = new Blob(grabadores[num].audioChunks, {
          type: mediaRecorder.mimeType || "audio/webm"
        });
        await subirAudio(blob, duracionSeg, num);
        setGrabandoUI(num, false);
      };

      mediaRecorder.start();
      estadoGrabacion(num, "Grabando... clic en Detener cuando termines.");
    } catch (error) {
      console.error(error);
      setGrabandoUI(num, false);
      if (error.name === "NotAllowedError") {
        estadoGrabacion(num, "Permiso de micrófono denegado.", true);
      } else if (error.name === "NotFoundError") {
        estadoGrabacion(num, "No se encontró micrófono.", true);
      } else {
        estadoGrabacion(num, "Error al abrir micrófono.", true);
      }
    }
  }

  function detenerGrabacion(num) {
    const rec = grabadores[num].mediaRecorder;
    if (rec && rec.state !== "inactive") rec.stop();
  }

  function setGrabandoUI(num, grabando) {
    const btnG = $(`btnGrabar${num}`);
    const btnD = $(`btnDetener${num}`);
    if (btnG) { btnG.disabled = grabando; btnG.classList.toggle("recording", grabando); }
    if (btnD) btnD.disabled = !grabando;
  }

  async function subirAudio(blob, duracionSeg, num) {
    try {
      const titulo = $(`titulo${num}`).value.trim();
      const alumno = $(`alumno${num}`).value.trim() || "Anónimo";
      const descripcion = $(`descripcion${num}`).value.trim();
      const categoria = $(`categoria${num}`).value || "General";
      const temporada = $(`temporada${num}`).value.trim() || "Temporada 1 - 2026";
      const destacado = $(`destacado${num}`).checked;
      const archivoImg = $(`imagen${num}`).files[0];

      if (!titulo) { estadoGrabacion(num, "Falta título.", true); return; }

      const extension = extensionDesdeBlob(blob);
      const archivo = `${Date.now()}-${slug(titulo)}.${extension}`;

      const { error: err1 } = await db.storage.from("audios").upload(archivo, blob, {
        contentType: blob.type || "audio/webm", upsert: false
      });
      if (err1) { estadoGrabacion(num, "Error al subir audio.", true); return; }

      const { data: urlData } = db.storage.from("audios").getPublicUrl(archivo);

      let urlImagen = "";
      if (archivoImg) {
        const nombreImg = `${Date.now()}-${slug(titulo)}.jpg`;
        const { error: errImg } = await db.storage.from("imagenes").upload(nombreImg, archivoImg, {
          contentType: archivoImg.type, upsert: false
        });
        if (!errImg) {
          const { data: imgData } = db.storage.from("imagenes").getPublicUrl(nombreImg);
          urlImagen = imgData.publicUrl;
        }
      }

      const { error: err2 } = await db.from("audios").insert({
        titulo, alumno, descripcion, categoria, temporada, destacado,
        archivo, url: urlData.publicUrl, imagen: urlImagen,
        publicado: true, duracion: duracionSeg || 0
      });

      if (err2) { estadoGrabacion(num, "Error al guardar.", true); return; }

      estadoGrabacion(num, "Episodio guardado correctamente.");
      $(`titulo${num}`).value = "";
      $(`alumno${num}`).value = "";
      $(`descripcion${num}`).value = "";
      $(`imagen${num}`).value = "";
      $(`destacado${num}`).checked = false;
      $(`categoria${num}`).value = "General";
      $(`temporada${num}`).value = "Temporada 1 - 2026";

      await cargarAudios();
    } catch (error) {
      console.error(error);
      estadoGrabacion(num, "Error al guardar.", true);
    }
  }

  // ======================================================
  // LISTAR
  // ======================================================

  async function cargarAudios() {
    if (!db) return;

    const { data, error } = await db
      .from("audios").select("*").order("creado_en", { ascending: false });

    if (error) { estadoGrabacion(1, "Error al cargar: " + error.message, true); return; }

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
      loopList.innerHTML = "<p class='small'>No hay audios todavía.</p>";
      return;
    }
    latest.forEach((item, i) => {
      const div = document.createElement("div");
      div.className = "audio-item";
      div.textContent = `${i + 1}. ${item.titulo} — ${item.alumno || "Anónimo"}`;
      loopList.appendChild(div);
    });
  }

  function renderTabla() {
    const tbody = $("tablaAudios");
    if (!tbody) return;
    tbody.innerHTML = "";

    if (!audios.length) {
      tbody.innerHTML = "<tr><td colspan='5'>No hay episodios.</td></tr>";
      return;
    }

    audios.forEach(item => {
      const publicado = item.publicado !== false;
      const tr = document.createElement("tr");

      tr.innerHTML = `
        <td>${item.titulo}</td>
        <td>${item.alumno || "Anónimo"}</td>
        <td><span class="temporada-badge">🗓️ ${item.temporada || "Temporada 1 - 2026"}</span></td>
        <td><span class="badge ${publicado ? "badge-on" : "badge-off"}">${publicado ? "Publicado" : "Oculto"}</span></td>
      `;

      const tdA = document.createElement("td");
      const acciones = document.createElement("div");
      acciones.className = "acciones";

      const b1 = btnMini("Escuchar", "btn-blue", () => reproducirUno(item.id));
      const b2 = btnMini("Editar", "btn-edit", () => abrirEditar(item.id));
      const b3 = btnMini(publicado ? "Ocultar" : "Publicar", publicado ? "btn-hide" : "btn-pub", () => togglePublicar(item.id));
      const b4 = btnMini("Borrar", "btn-del", () => borrarAudio(item.id));

      [b1, b2, b3, b4].forEach(b => acciones.appendChild(b));
      tdA.appendChild(acciones);
      tr.appendChild(tdA);
      tbody.appendChild(tr);
    });
  }

  function btnMini(texto, clase, onclick) {
    const b = document.createElement("button");
    b.textContent = texto;
    b.className = "btn btn-mini " + clase;
    b.onclick = onclick;
    return b;
  }

  // ======================================================
  // REPRODUCCIÓN
  // ======================================================

  function reproducirUno(id) {
    const item = audios.find(a => a.id === id);
    if (!item) return;
    loopActivo = false;
    const r = $("reproductor");
    r.src = item.url;
    r.play().catch(() => estadoReproduccion("Pulsa play.", true));
    estadoReproduccion(`Reproduciendo: ${item.titulo}`);
  }

  function reproducirLoop() {
    playlist = audios.slice(0, 3);
    if (!playlist.length) { estadoReproduccion("No hay audios.", true); return; }
    loopActivo = true;
    indice = 0;
    reproducirActual();
  }

  function reproducirActual() {
    const item = playlist[indice];
    if (!item) return;
    const r = $("reproductor");
    r.src = item.url;
    r.play().catch(() => {});
    estadoReproduccion(`Loop: ${item.titulo}`);
  }

  function siguienteSiLoop() {
    if (loopActivo && playlist.length > 0) {
      indice = (indice + 1) % playlist.length;
      reproducirActual();
    }
  }

  function detenerReproduccion() {
    loopActivo = false;
    const r = $("reproductor");
    r.pause();
    r.removeAttribute("src");
    r.load();
    estadoReproduccion("Detenido.");
  }

  // ======================================================
  // EDITAR / PUBLICAR / BORRAR
  // ======================================================

  function abrirEditar(id) {
    const item = audios.find(a => a.id === id);
    if (!item) return;
    $("editId").value = item.id;
    $("editTitulo").value = item.titulo;
    $("editAlumno").value = item.alumno || "";
    $("editDescripcion").value = item.descripcion || "";
    $("editCategoria").value = item.categoria || "General";
    $("editTemporada").value = item.temporada || "Temporada 1 - 2026";
    $("editModal").showModal();
  }

  async function guardarEdicion(event) {
    event.preventDefault();
    const id = $("editId").value;
    const titulo = $("editTitulo").value.trim();
    const alumno = $("editAlumno").value.trim() || "Anónimo";
    const descripcion = $("editDescripcion").value.trim();
    const categoria = $("editCategoria").value;
    const temporada = $("editTemporada").value.trim() || "Temporada 1 - 2026";
    const archivoImg = $("editImagen").files[0];

    if (!titulo) { alert("Título vacío."); return; }

    let urlImagen = undefined;
    if (archivoImg) {
      const nombreImg = `${Date.now()}-edit.jpg`;
      const { error } = await db.storage.from("imagenes").upload(nombreImg, archivoImg);
      if (!error) {
        const { data } = db.storage.from("imagenes").getPublicUrl(nombreImg);
        urlImagen = data.publicUrl;
      }
    }

    const update = { titulo, alumno, descripcion, categoria, temporada };
    if (urlImagen) update.imagen = urlImagen;

    const { error } = await db.from("audios").update(update).eq("id", id);
    if (error) { alert("Error: " + error.message); return; }

    $("editModal").close();
    await cargarAudios();
  }

  async function togglePublicar(id) {
    const item = audios.find(a => a.id === id);
    if (!item) return;
    const nuevo = !(item.publicado !== false);
    await db.from("audios").update({ publicado: nuevo }).eq("id", id);
    await cargarAudios();
  }

  async function borrarAudio(id) {
    const item = audios.find(a => a.id === id);
    if (!item || !confirm(`¿Borrar "${item.titulo}"?`)) return;
    if (item.archivo) await db.storage.from("audios").remove([item.archivo]);
    await db.from("audios").delete().eq("id", id);
    detenerReproduccion();
    await cargarAudios();
  }

  // ======================================================
  // UTILIDADES
  // ======================================================

  function estadoGrabacion(num, t, err) {
    const el = $(`estadoGrabacion${num}`);
    if (!el) return;
    el.textContent = t;
    el.classList.toggle("error", !!err);
  }

  function estadoReproduccion(t, err) {
    const el = $("estadoReproduccion");
    if (!el) return;
    el.textContent = t;
    el.classList.toggle("error", !!err);
  }

  function slug(t) {
    return t.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "audio";
  }

  function extensionDesdeBlob(b) {
    if (!b || !b.type) return "webm";
    if (b.type.includes("mp4")) return "mp4";
    if (b.type.includes("ogg")) return "ogg";
    if (b.type.includes("mpeg")) return "mp3";
    return "webm";
  }
})();