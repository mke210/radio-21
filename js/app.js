(function () {
  "use strict";

  const $ = (id) => document.getElementById(id);

  function on(id, evento, fn) {
    const el = $(id);
    if (el) el.addEventListener(evento, fn);
  }

  const config = { url: window.SUPABASE_URL, key: window.SUPABASE_ANON_KEY };
  const configOk = config.url && !config.url.includes("PEGAR") && config.key && !config.key.includes("PEGAR");

  let db = null;
  if (!window.supabase) console.error("No se cargó Supabase.");
  else if (!configOk) console.error("Falta configurar js/config.js");
  else db = window.P21_DB || window.supabase.createClient(config.url, config.key);

  // ===== Estado general =====
  let audios = [];
  let playlist = [];
  let indice = 0;
  let loopActivo = false;

  // ===== Estado de sesión de grabación =====
  let audioCtx = null;
  let rec = null;
  let chunks = [];
  let streams = [];
  let anMaster = null, an1 = null, an2 = null;
  let musicFile = null;
  let musicPreview = null;
  let musicRouted = null;
  let musicGainNode = null;
  let rafId = null;
  let timerInt = null;
  let seg = 0;
  let pausado = false;

  // ===== Eventos =====
  on("btnGrabar", "click", iniciarGrabacion);
  on("btnPausa", "click", pausarReanudar);
  on("btnDetener", "click", () => { if (rec && rec.state !== "inactive") rec.stop(); });
  on("btnMusica", "click", toggleMusicaPreview);
  on("musicaFile", "change", cargarMusica);
  on("musicaVol", "input", () => {
    const v = parseFloat($("musicaVol").value);
    if (musicPreview) musicPreview.volume = v;
    if (musicGainNode) musicGainNode.gain.value = v;
  });
  on("btnPlaySel", "click", reproducirSeleccion);
  on("btnLoopToggle", "click", toggleLoop);
  on("btnStop", "click", detenerReproduccion);
  on("btnActualizar", "click", cargarAudios);
  on("editForm", "submit", guardarEdicion);
  on("btnCancelarEditar", "click", () => $("editModal").close());
  on("reproductor", "ended", alTerminarEpisodio);

  cargarMics();
  if (navigator.mediaDevices) navigator.mediaDevices.addEventListener("devicechange", cargarMics);
  cargarAudios();

  // ======================================================
  // MICRÓFONOS
  // ======================================================

  async function cargarMics() {
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      const mics = devices.filter(d => d.kind === "audioinput");
      ["mic1", "mic2"].forEach(id => {
        const sel = $(id);
        const val = sel.value;
        sel.innerHTML = '<option value="">Micrófono predeterminado</option>';
        mics.forEach((m, i) => {
          sel.innerHTML += `<option value="${m.deviceId}">${m.label || "Micrófono " + (i + 1)}</option>`;
        });
        sel.value = val;
      });
    } catch (e) { console.error(e); }
  }

  async function pedirMic(deviceId) {
    try {
      return await navigator.mediaDevices.getUserMedia({
        audio: deviceId ? { deviceId: { exact: deviceId } } : true
      });
    } catch (e) {
      return await navigator.mediaDevices.getUserMedia({ audio: true });
    }
  }

  // ======================================================
  // MÚSICA DE FONDO
  // ======================================================

  function cargarMusica() {
    const f = $("musicaFile").files[0];
    if (!f) return;
    musicFile = f;
    $("musicaNombre").textContent = "🎵 " + f.name;
    if (musicPreview) musicPreview.pause();
    musicPreview = new Audio(URL.createObjectURL(f));
    musicPreview.volume = parseFloat($("musicaVol").value);
    $("btnMusica").disabled = false;
  }

  function toggleMusicaPreview() {
    if (!musicPreview) return;
    if (musicPreview.paused) {
      musicPreview.loop = $("musicaLoop").checked;
      musicPreview.play();
      $("btnMusica").textContent = "⏸ Música";
    } else {
      musicPreview.pause();
      $("btnMusica").textContent = "▶ Música";
    }
  }

  // ======================================================
  // GRABACIÓN (mezcla de locutores + música)
  // ======================================================

  async function iniciarGrabacion() {
    const titulo = $("titulo").value.trim();
    if (!titulo) { estadoGrabacion("Escribe un título.", true); return; }
    if (!db) { estadoGrabacion("Falta configurar Supabase.", true); return; }

    const loc1 = $("loc1Activo").checked;
    const loc2 = $("loc2Activo").checked;
    if (!loc1 && !loc2) { estadoGrabacion("Activa al menos un locutor.", true); return; }

    estadoGrabacion("Preparando sesión...");

    try {
      audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      await audioCtx.resume();

      const master = audioCtx.createGain();
      anMaster = audioCtx.createAnalyser(); anMaster.fftSize = 64;
      const dest = audioCtx.createMediaStreamDestination();
      master.connect(anMaster);
      master.connect(dest);

      streams = [];

      if (loc1) {
        const s = await pedirMic($("mic1").value);
        streams.push(s);
        const src = audioCtx.createMediaStreamSource(s);
        an1 = audioCtx.createAnalyser(); an1.fftSize = 64;
        src.connect(master); src.connect(an1);
      } else { an1 = null; }

      if (loc2) {
        const s = await pedirMic($("mic2").value);
        streams.push(s);
        const src = audioCtx.createMediaStreamSource(s);
        an2 = audioCtx.createAnalyser(); an2.fftSize = 64;
        src.connect(master); src.connect(an2);
      } else { an2 = null; }

      // Música incluida en la grabación
      if (musicFile && $("musicaIncluir").checked) {
        musicRouted = new Audio(URL.createObjectURL(musicFile));
        musicRouted.loop = $("musicaLoop").checked;
        const srcNode = audioCtx.createMediaElementSource(musicRouted);
        musicGainNode = audioCtx.createGain();
        musicGainNode.gain.value = parseFloat($("musicaVol").value);
        srcNode.connect(musicGainNode);
        musicGainNode.connect(master);
        musicGainNode.connect(audioCtx.destination);
        musicRouted.play();
        if (musicPreview) musicPreview.pause();
      }

      cargarMics(); // refresca nombres tras dar permiso

      chunks = [];
      rec = new MediaRecorder(dest.stream);
      rec.ondataavailable = e => { if (e.data.size > 0) chunks.push(e.data); };
      rec.onstop = async () => {
        const blob = new Blob(chunks, { type: rec.mimeType || "audio/webm" });
        const dur = seg;
        limpiarSesion();
        estadoGrabacion("Subiendo y guardando episodio...");
        await subirAudio(blob, dur);
        setUIGrabacion("idle");
      };

      rec.start();
      seg = 0; pausado = false;
      iniciarTimer();
      iniciarEcualizador();
      setUIGrabacion("grabando");
      estadoGrabacion("Grabando sesión...");
    } catch (error) {
      console.error(error);
      limpiarSesion();
      setUIGrabacion("idle");
      estadoGrabacion(error.name === "NotAllowedError"
        ? "Permiso de micrófono denegado."
        : "Error al iniciar la sesión de grabación.", true);
    }
  }

  function pausarReanudar() {
    if (!rec) return;
    if (!pausado) {
      rec.pause();
      if (musicRouted) musicRouted.pause();
      pausado = true;
      clearInterval(timerInt);
      $("btnPausa").textContent = "▶ Reanudar";
      estadoGrabacion("Grabación en pausa.");
    } else {
      rec.resume();
      if (musicRouted) musicRouted.play();
      pausado = false;
      iniciarTimer();
      $("btnPausa").textContent = "⏸ Pausa";
      estadoGrabacion("Grabando sesión...");
    }
  }

  function limpiarSesion() {
    streams.forEach(s => s.getTracks().forEach(t => t.stop()));
    streams = [];
    if (musicRouted) { musicRouted.pause(); musicRouted = null; }
    musicGainNode = null;
    if (rafId) cancelAnimationFrame(rafId);
    if (timerInt) clearInterval(timerInt);
    if (audioCtx) { audioCtx.close(); audioCtx = null; }
    anMaster = an1 = an2 = null;
    ["eqMaster", "eq1", "eq2"].forEach(id => {
      const c = $(id);
      if (c) c.getContext("2d").clearRect(0, 0, c.width, c.height);
    });
  }

  function setUIGrabacion(modo) {
    if (modo === "grabando") {
      $("btnGrabar").disabled = true;
      $("btnGrabar").classList.add("recording");
      $("btnPausa").disabled = false;
      $("btnDetener").disabled = false;
    } else {
      $("btnGrabar").disabled = false;
      $("btnGrabar").classList.remove("recording");
      $("btnPausa").disabled = true;
      $("btnPausa").textContent = "⏸ Pausa";
      $("btnDetener").disabled = true;
      $("timer").textContent = "00:00";
    }
  }

  function iniciarTimer() {
    clearInterval(timerInt);
    timerInt = setInterval(() => {
      seg++;
      const m = String(Math.floor(seg / 60)).padStart(2, "0");
      const s = String(seg % 60).padStart(2, "0");
      $("timer").textContent = `${m}:${s}`;
    }, 1000);
  }

  // ======================================================
  // ECUALIZADOR
  // ======================================================

  function iniciarEcualizador() {
    if (rafId) cancelAnimationFrame(rafId);
    const paso = () => {
      rafId = requestAnimationFrame(paso);
      dibujar(anMaster, $("eqMaster"));
      dibujar(an1, $("eq1"));
      dibujar(an2, $("eq2"));
    };
    paso();
  }

  function dibujar(an, canvas) {
    if (!an || !canvas) return;
    const data = new Uint8Array(an.frequencyBinCount);
    an.getByteFrequencyData(data);
    const ctx = canvas.getContext("2d");
    const W = canvas.width, H = canvas.height;
    ctx.clearRect(0, 0, W, H);
    const bars = 24;
    const step = Math.max(1, Math.floor(data.length / bars));
    const bw = W / bars;
    for (let i = 0; i < bars; i++) {
      const v = data[i * step] / 255;
      const h = Math.max(2, v * H);
      ctx.fillStyle = v > 0.7 ? "#e05252" : "#e3b64f";
      ctx.fillRect(i * bw + 1, H - h, bw - 2, h);
    }
  }

  // ======================================================
  // GUARDAR EPISODIO
  // ======================================================

  async function subirAudio(blob, duracionSeg) {
    try {
      const titulo = $("titulo").value.trim();
      const alumno = $("alumno").value.trim() || "Anónimo";
      const descripcion = $("descripcion").value.trim();
      const categoria = $("categoria").value || "General";
      const temporada = $("temporada").value.trim() || "Temporada 1 - 2026";
      const destacado = $("destacado").checked;
      const archivoImg = $("imagen").files[0];

      const extension = extensionDesdeBlob(blob);
      const archivo = `${Date.now()}-${slug(titulo)}.${extension}`;

      const { error: err1 } = await db.storage.from("audios").upload(archivo, blob, {
        contentType: blob.type || "audio/webm", upsert: false
      });
      if (err1) { estadoGrabacion("Error al subir audio.", true); return; }

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

      if (err2) { estadoGrabacion("Error al guardar.", true); return; }

      estadoGrabacion("✅ Episodio guardado correctamente.");
      ["titulo", "alumno", "descripcion"].forEach(id => $(id).value = "");
      $("imagen").value = "";
      $("destacado").checked = false;

      await cargarAudios();
    } catch (error) {
      console.error(error);
      estadoGrabacion("Error al guardar.", true);
    }
  }

  // ======================================================
  // PLAYER DE CABINA (selección + loop)
  // ======================================================

  function renderSeleccion() {
    const cont = $("listaSeleccion");
    if (!cont) return;
    cont.innerHTML = "";
    if (!audios.length) {
      cont.innerHTML = "<p class='small'>No hay episodios.</p>";
      return;
    }
    audios.forEach(a => {
      const label = document.createElement("label");
      label.className = "sel-item";
      label.innerHTML = `<input type="checkbox" value="${a.id}" /> <span>${a.titulo}</span>`;
      cont.appendChild(label);
    });
  }

  function reproducirSeleccion() {
    const marcados = [...document.querySelectorAll("#listaSeleccion input:checked")]
      .map(c => c.value);
    playlist = marcados.length
      ? audios.filter(a => marcados.includes(a.id))
      : audios.slice();
    if (!playlist.length) { estadoReproduccion("No hay episodios.", true); return; }
    indice = 0;
    reproducirActual();
  }

  function toggleLoop() {
    loopActivo = !loopActivo;
    const btn = $("btnLoopToggle");
    btn.textContent = loopActivo ? "🔁 Loop: ON" : "🔁 Loop: OFF";
    btn.classList.toggle("btn-gold", loopActivo);
    btn.classList.toggle("btn-ghost", !loopActivo);
  }

  function alTerminarEpisodio() {
    if (!playlist.length) return;
    if (loopActivo) {
      indice = (indice + 1) % playlist.length;
      reproducirActual();
    } else if (indice < playlist.length - 1) {
      indice++;
      reproducirActual();
    } else {
      estadoReproduccion("Fin de la selección.");
    }
  }

  function reproducirActual() {
    const item = playlist[indice];
    if (!item) return;
    const r = $("reproductor");
    r.src = item.url;
    r.play().catch(() => {});
    estadoReproduccion(`Sonando: ${item.titulo}`);
  }

  function reproducirUno(id) {
    const item = audios.find(a => a.id === id);
    if (!item) return;
    playlist = [item];
    indice = 0;
    reproducirActual();
  }

  function detenerReproduccion() {
    const r = $("reproductor");
    r.pause();
    r.removeAttribute("src");
    r.load();
    estadoReproduccion("Detenido.");
  }

  // ======================================================
  // LISTAR / TABLA / EDITAR / BORRAR
  // ======================================================

  async function cargarAudios() {
    if (!db) return;
    const { data, error } = await db.from("audios").select("*").order("creado_en", { ascending: false });
    if (error) { estadoGrabacion("Error al cargar: " + error.message, true); return; }
    audios = data || [];
    renderSeleccion();
    renderTabla();
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
      const acc = document.createElement("div");
      acc.className = "acciones";
      acc.appendChild(btnMini("Escuchar", "btn-blue", () => reproducirUno(item.id)));
      acc.appendChild(btnMini("Editar", "btn-edit", () => abrirEditar(item.id)));
      acc.appendChild(btnMini(publicado ? "Ocultar" : "Publicar", publicado ? "btn-hide" : "btn-pub", () => togglePublicar(item.id)));
      acc.appendChild(btnMini("Borrar", "btn-del", () => borrarAudio(item.id)));
      tdA.appendChild(acc);
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
    await db.from("audios").update({ publicado: !(item.publicado !== false) }).eq("id", id);
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

  function estadoGrabacion(t, err) {
    const el = $("estadoGrabacion");
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