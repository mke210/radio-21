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

  // ===== Claves de configuración persistente =====
  const LS = {
    loop: "p21_loop",
    sel: "p21_sel",
    last: "p21_last",
    vol: "p21_musicvol"
  };

  // ===== Estado general =====
  let audios = [];
  let musicas = [];
  let playlist = [];
  let indice = 0;
  let loopActivo = false;
  let iniciadoAuto = false;

  let ctx = null;

  // ===== Locutores =====
  const loc = {
    1: { stream: null, src: null, an: null },
    2: { stream: null, src: null, an: null }
  };

  // ===== Grabación =====
  let rec = null;
  let chunks = [];
  let anMaster = null;
  let masterNode = null;
  let musicaConectada = false;
  let timerInt = null;
  let seg = 0;
  let pausado = false;

  // ===== Música local =====
  let musicPreview = null;
  let musicSrcNode = null;
  let musicGainNode = null;
  let musicAnalyser = null;

  // ===== Ducking =====
  let ultimaVoz = 0;

  // ======================================================
  // EVENTOS
  // ======================================================

  on("btnGrabar", "click", iniciarGrabacion);
  on("btnPausa", "click", pausarReanudar);
  on("btnDetener", "click", () => { if (rec && rec.state !== "inactive") rec.stop(); });

  on("btnMusica", "click", toggleMusica);
  on("btnQuitarMusica", "click", quitarMusicaLocal);
  on("musicaFile", "change", cargarMusicaLocal);
  on("musicaLoop", "change", () => { if (musicPreview) musicPreview.loop = $("musicaLoop").checked; });
  on("musicaVol", "input", () => {
    const v = parseFloat($("musicaVol").value);
    if (musicGainNode) musicGainNode.gain.value = v;
    localStorage.setItem(LS.vol, String(v));
  });

  on("subirMusica", "change", subirMusicaDB);
  on("btnPlaySel", "click", reproducirSeleccion);
  on("btnLoopToggle", "click", toggleLoop);
  on("btnStop", "click", detenerReproduccion);
  on("btnActivarSonido", "click", activarSonido);
  on("btnActualizar", "click", () => cargarTodo());
  on("listaSeleccion", "change", () => { guardarSeleccionLocal(); guardarConfigRemota(); });

  on("editForm", "submit", guardarEdicion);
  on("btnCancelarEditar", "click", () => $("editModal").close());
  on("reproductor", "ended", alTerminarEpisodio);

  on("loc1Activo", "change", () => toggleLocutor(1));
  on("loc2Activo", "change", () => toggleLocutor(2));
  on("mic1", "change", async () => {
    if ($("loc1Activo").checked) { detenerLocutor(1); await asegurarLocutor(1); }
  });
  on("mic2", "change", async () => {
    if ($("loc2Activo").checked) { detenerLocutor(2); await asegurarLocutor(2); }
  });

  // Restaurar volumen de música guardado
  const volGuardado = localStorage.getItem(LS.vol);
  if (volGuardado && $("musicaVol")) $("musicaVol").value = volGuardado;

  cargarMics();
  if (navigator.mediaDevices) navigator.mediaDevices.addEventListener("devicechange", cargarMics);
  iniciarLoopSiempre();
  cargarTodo();

  function asegurarCtx() {
    if (!ctx) ctx = new (window.AudioContext || window.webkitAudioContext)();
    if (ctx.state === "suspended") ctx.resume();
    return ctx;
  }

  // ======================================================
  // PERSISTENCIA DEL PLAYER
  // ======================================================

  function leerSeleccionGuardada() {
    try {
      const arr = JSON.parse(localStorage.getItem(LS.sel));
      return Array.isArray(arr) ? arr : [];
    } catch (e) { return []; }
  }

    function guardarSeleccionLocal() {
    const marcados = [...document.querySelectorAll("#listaSeleccion input:checked")].map(c => c.value);
    localStorage.setItem(LS.sel, JSON.stringify(marcados));
  }

  // Publica la programación de la cabina para que el inicio
  // (y cualquier dispositivo) suene con tu misma selección y pista.
  async function guardarConfigRemota() {
    if (!db) return;
    const sel = [...document.querySelectorAll("#listaSeleccion input:checked")].map(c => c.value);
    const actual = playlist[indice];
    try {
      await db.from("config").upsert({
        id: "player",
        sel: sel,
        last: actual ? actual._tipo + ":" + actual.id : null,
        loop: loopActivo,
        actualizado_en: new Date().toISOString()
      });
    } catch (e) {
      console.error("No se pudo publicar la configuración:", e);
    }
  }

  function restaurarChecks() {
    const guardada = leerSeleccionGuardada();
    document.querySelectorAll("#listaSeleccion input").forEach(inp => {
      inp.checked = guardada.includes(inp.value);
    });
  }

  // ======================================================
  // LOCUTORES
  // ======================================================

  async function toggleLocutor(num) {
    if ($(`loc${num}Activo`).checked) await asegurarLocutor(num);
    else detenerLocutor(num);
  }

  async function asegurarLocutor(num) {
    if (loc[num].stream) return;
    try {
      asegurarCtx();
      const stream = await pedirMic($(`mic${num}`).value);
      const src = ctx.createMediaStreamSource(stream);
      const an = ctx.createAnalyser();
      an.fftSize = 512;
      src.connect(an);
      loc[num] = { stream, src, an };
      cargarMics();
    } catch (e) {
      console.error(e);
      $(`loc${num}Activo`).checked = false;
      estadoGrabacion("No se pudo abrir el micrófono del locutor " + num + ".", true);
    }
  }

  function detenerLocutor(num) {
    const L = loc[num];
    if (L.stream) L.stream.getTracks().forEach(t => t.stop());
    try { if (L.src) L.src.disconnect(); if (L.an) L.an.disconnect(); } catch (e) {}
    loc[num] = { stream: null, src: null, an: null };
  }

  // ======================================================
  // DUCKING
  // ======================================================

  function nivelVoz(an) {
    if (!an) return 0;
    const data = new Uint8Array(an.fftSize);
    an.getByteTimeDomainData(data);
    let sum = 0;
    for (let i = 0; i < data.length; i++) {
      const v = (data[i] - 128) / 128;
      sum += v * v;
    }
    return Math.sqrt(sum / data.length);
  }

  function aplicarDucking() {
    if (!musicGainNode || !ctx) return;
    const nivel = Math.max(nivelVoz(loc[1].an), nivelVoz(loc[2].an));
    if (nivel > 0.06) ultimaVoz = Date.now();
    const conVoz = (Date.now() - ultimaVoz) < 800;
    const base = parseFloat($("musicaVol").value) || 0.5;
    const objetivo = conVoz ? base * 0.5 : base;
    musicGainNode.gain.setTargetAtTime(objetivo, ctx.currentTime, 0.2);
  }

  function iniciarLoopSiempre() {
    const paso = () => {
      requestAnimationFrame(paso);
      dibujarBarras(loc[1].an, $("eq1"));
      dibujarBarras(loc[2].an, $("eq2"));
      dibujarRetro(musicAnalyser, $("eqMusica"));
      aplicarDucking();
      if (anMaster && rec && rec.state === "recording" && !pausado) {
        dibujarBarras(anMaster, $("eqMaster"));
      }
    };
    paso();
  }

  // ======================================================
  // CARGA + AUTO-INICIO (con configuración restaurada)
  // ======================================================

  async function cargarTodo() {
    await Promise.all([cargarAudios(), cargarMusicaDB()]);
    renderSeleccion();
    restaurarChecks();
    if (!iniciadoAuto) {
      iniciadoAuto = true;
      autoInicio();
    }
  }

  function autoInicio() {
    // Restaurar estado del loop
    if (localStorage.getItem(LS.loop) === "1") {
      loopActivo = true;
      const btn = $("btnLoopToggle");
      if (btn) {
        btn.textContent = "🔁 Loop: ON";
        btn.classList.add("btn-gold");
        btn.classList.remove("btn-ghost");
      }
    }

    // Restaurar selección guardada como playlist
    const selGuardada = leerSeleccionGuardada();
    playlist = selGuardada.length
      ? selGuardada.map(resolverItem).filter(Boolean)
      : listaCompleta();

    if (!playlist.length) {
      estadoReproduccion("Sin contenido todavía. Sube música o graba episodios.");
      return;
    }

    // Restaurar última pista que sonaba
    const ultimo = localStorage.getItem(LS.last);
    const idx = playlist.findIndex(p => (p._tipo + ":" + p.id) === ultimo);
    indice = idx >= 0 ? idx : 0;

    const r = $("reproductor");
    r.src = playlist[indice].url;

    r.play()
      .then(() => {
        $("avisoSonido").classList.add("oculto");
        estadoReproduccion("🎶 Sonando: " + playlist[indice].titulo);
      })
      .catch(() => {
        r.muted = true;
        r.play()
          .then(() => {
            $("avisoSonido").classList.remove("oculto");
            estadoReproduccion("🎶 Sonando (silenciado): " + playlist[indice].titulo);
          })
          .catch(() => {});
      });
  }

  function activarSonido() {
    const r = $("reproductor");
    r.muted = false;
    $("avisoSonido").classList.add("oculto");
    estadoReproduccion("🔊 Sonido activado.");
  }

  // ======================================================
  // BIBLIOTECA DE MÚSICA
  // ======================================================

  async function cargarMusicaDB() {
    if (!db) return;
    const { data, error } = await db.from("musica").select("*").order("creado_en", { ascending: false });
    if (!error) musicas = data || [];
  }

  async function subirMusicaDB() {
    const files = [...$("subirMusica").files];
    if (!files.length || !db) return;

    estadoReproduccion("📤 Subiendo música a la biblioteca...");

    for (const f of files) {
      const base = f.name.replace(/\.[^.]+$/, "");
      const nombre = `${Date.now()}-${slug(base)}.${extDesdeNombre(f.name)}`;

      const { error: errUp } = await db.storage.from("musica").upload(nombre, f, {
        contentType: f.type || "audio/mpeg",
        upsert: false
      });
      if (errUp) { console.error(errUp); continue; }

      const { data: urlData } = db.storage.from("musica").getPublicUrl(nombre);

      await db.from("musica").insert({
        titulo: base,
        archivo: nombre,
        url: urlData.publicUrl
      });
    }

    $("subirMusica").value = "";
    estadoReproduccion("✅ Música guardada. Ya no se pierde al recargar.");
    await cargarMusicaDB();
    renderSeleccion();
    restaurarChecks();
  }

  async function borrarMusicaDB(id) {
    const item = musicas.find(m => m.id === id);
    if (!item || !confirm(`¿Eliminar "${item.titulo}" de la biblioteca?`)) return;
    if (item.archivo) await db.storage.from("musica").remove([item.archivo]);
    await db.from("musica").delete().eq("id", id);
    await cargarMusicaDB();
    renderSeleccion();
    restaurarChecks();
    estadoReproduccion("🗑 Pista eliminada de la biblioteca.");
  }

  // ======================================================
  // SELECCIÓN MIXTA
  // ======================================================

  function renderSeleccion() {
    const cont = $("listaSeleccion");
    if (!cont) return;
    cont.innerHTML = "";

    const g1 = document.createElement("div");
    g1.className = "grupo-titulo";
    g1.textContent = "🎵 Música";
    cont.appendChild(g1);

    if (!musicas.length) cont.appendChild(pSmall("Sin música subida. Usa 📤 Subir MP3."));
    musicas.forEach(m => {
      const fila = document.createElement("div");
      fila.className = "sel-item";
      fila.innerHTML = `<label class="sel-label"><input type="checkbox" value="m:${m.id}" /> <span>🎵 ${m.titulo}</span></label>`;
      const b = document.createElement("button");
      b.className = "btn btn-mini btn-del";
      b.textContent = "🗑";
      b.title = "Eliminar de la biblioteca";
      b.onclick = () => borrarMusicaDB(m.id);
      fila.appendChild(b);
      cont.appendChild(fila);
    });

    const g2 = document.createElement("div");
    g2.className = "grupo-titulo";
    g2.textContent = "🎙️ Episodios";
    cont.appendChild(g2);

    if (!audios.length) cont.appendChild(pSmall("Sin episodios todavía."));
    audios.forEach(a => cont.appendChild(itemSel("e:" + a.id, a.titulo)));
  }

  function itemSel(valor, texto) {
    const label = document.createElement("label");
    label.className = "sel-item";
    label.innerHTML = `<input type="checkbox" value="${valor}" /> <span>${texto}</span>`;
    return label;
  }

  function pSmall(t) {
    const p = document.createElement("p");
    p.className = "small";
    p.style.margin = "4px 0";
    p.textContent = t;
    return p;
  }

  function resolverItem(valor) {
    const tipo = valor.slice(0, 1);
    const id = valor.slice(2);
    if (tipo === "m") {
      const m = musicas.find(x => x.id === id);
      return m ? { ...m, _tipo: "m" } : null;
    }
    const e = audios.find(x => x.id === id);
    return e ? { ...e, _tipo: "e" } : null;
  }

  function listaCompleta() {
    return [
      ...musicas.map(m => ({ ...m, _tipo: "m" })),
      ...audios.map(a => ({ ...a, _tipo: "e" }))
    ];
  }

  function reproducirSeleccion() {
    const marcados = [...document.querySelectorAll("#listaSeleccion input:checked")].map(c => c.value);
    localStorage.setItem(LS.sel, JSON.stringify(marcados));

    playlist = marcados.length
      ? marcados.map(resolverItem).filter(Boolean)
      : listaCompleta();

    if (!playlist.length) { estadoReproduccion("No hay contenido para reproducir.", true); return; }

    indice = 0;
    reproducirActual();
  }

    function toggleLoop() {
    loopActivo = !loopActivo;
    localStorage.setItem(LS.loop, loopActivo ? "1" : "0");
    guardarConfigRemota();

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
    localStorage.setItem(LS.last, item._tipo + ":" + item.id);
    guardarConfigRemota();
    const r = $("reproductor");
    r.src = item.url;
    r.play().catch(() => {});
    estadoReproduccion(`Sonando: ${item.titulo}`);
  }

  function reproducirUno(id) {
    const item = audios.find(a => a.id === id);
    if (!item) return;
    playlist = [{ ...item, _tipo: "e" }];
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
  // MÚSICA LOCAL
  // ======================================================

  function cargarMusicaLocal() {
    const f = $("musicaFile").files[0];
    if (!f) return;

    if (musicPreview) musicPreview.pause();
    musicPreview = new Audio(URL.createObjectURL(f));
    musicPreview.volume = 1;
    musicPreview.loop = $("musicaLoop").checked;

    if (musicSrcNode) {
      try { musicSrcNode.disconnect(); musicGainNode.disconnect(); musicAnalyser.disconnect(); } catch (e) {}
      musicSrcNode = musicGainNode = musicAnalyser = null;
    }
    if (ctx) construirGraficoMusica();

    $("musicaNombre").textContent = "🎵 " + f.name;
    $("btnMusica").disabled = false;
    $("btnMusica").textContent = "▶ Música";
    $("btnQuitarMusica").disabled = false;
  }

  function construirGraficoMusica() {
    if (!ctx || !musicPreview || musicSrcNode) return;
    musicSrcNode = ctx.createMediaElementSource(musicPreview);
    musicGainNode = ctx.createGain();
    musicGainNode.gain.value = parseFloat($("musicaVol").value);
    musicAnalyser = ctx.createAnalyser();
    musicAnalyser.fftSize = 64;
    musicSrcNode.connect(musicGainNode);
    musicGainNode.connect(musicAnalyser);
    musicAnalyser.connect(ctx.destination);
  }

  function toggleMusica() {
    if (!musicPreview) return;
    if (musicPreview.paused) {
      asegurarCtx();
      construirGraficoMusica();
      musicPreview.play();
      $("btnMusica").textContent = "⏸ Música";
    } else {
      musicPreview.pause();
      $("btnMusica").textContent = "▶ Música";
    }
  }

  function quitarMusicaLocal() {
    if (musicPreview) musicPreview.pause();
    musicPreview = null;
    if (musicSrcNode) {
      try { musicSrcNode.disconnect(); musicGainNode.disconnect(); musicAnalyser.disconnect(); } catch (e) {}
      musicSrcNode = musicGainNode = musicAnalyser = null;
    }
    $("musicaFile").value = "";
    $("musicaNombre").textContent = "Sin pista cargada";
    $("btnMusica").disabled = true;
    $("btnMusica").textContent = "▶ Música";
    $("btnQuitarMusica").disabled = true;
  }

  // ======================================================
  // ECUALIZADORES
  // ======================================================

  function dibujarRetro(an, canvas) {
    if (!canvas) return;
    const c2 = canvas.getContext("2d");
    const W = canvas.width, H = canvas.height;
    c2.clearRect(0, 0, W, H);
    const bars = 20, segs = 12;
    const bw = W / bars, segH = H / segs;
    let data = null;
    if (an) {
      data = new Uint8Array(an.frequencyBinCount);
      an.getByteFrequencyData(data);
    }
    const step = data ? Math.max(1, Math.floor(data.length / bars)) : 1;
    for (let i = 0; i < bars; i++) {
      const v = data ? data[i * step] / 255 : 0;
      const lit = Math.round(v * segs);
      for (let s = 0; s < segs; s++) {
        const y = H - (s + 1) * segH;
        c2.fillStyle = s < lit
          ? (s < 6 ? "#39d353" : s < 9 ? "#ffd300" : "#ff4136")
          : "rgba(255,255,255,0.06)";
        c2.fillRect(i * bw + 2, y + 1, bw - 4, segH - 2);
      }
    }
  }

  function dibujarBarras(an, canvas) {
    if (!an || !canvas) return;
    const data = new Uint8Array(an.frequencyBinCount);
    an.getByteFrequencyData(data);
    const c2 = canvas.getContext("2d");
    const W = canvas.width, H = canvas.height;
    c2.clearRect(0, 0, W, H);
    const bars = 24;
    const step = Math.max(1, Math.floor(data.length / bars));
    const bw = W / bars;
    for (let i = 0; i < bars; i++) {
      const v = data[i * step] / 255;
      const h = Math.max(2, v * H);
      c2.fillStyle = v > 0.7 ? "#e05252" : "#e3b64f";
      c2.fillRect(i * bw + 1, H - h, bw - 2, h);
    }
  }

  // ======================================================
  // GRABACIÓN
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
      asegurarCtx();

      if (loc1) await asegurarLocutor(1);
      if (loc2) await asegurarLocutor(2);

      masterNode = ctx.createGain();
      anMaster = ctx.createAnalyser(); anMaster.fftSize = 64;
      const dest = ctx.createMediaStreamDestination();
      masterNode.connect(anMaster);
      masterNode.connect(dest);

      if (loc1 && loc[1].src) loc[1].src.connect(masterNode);
      if (loc2 && loc[2].src) loc[2].src.connect(masterNode);

      musicaConectada = false;
      if ($("musicaIncluir").checked) {
        if (!musicSrcNode && musicPreview) construirGraficoMusica();
        if (musicGainNode) {
          musicGainNode.connect(masterNode);
          musicaConectada = true;
        }
      }

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
      pausado = true;
      clearInterval(timerInt);
      $("btnPausa").textContent = "▶ Reanudar";
      estadoGrabacion("Grabación en pausa.");
    } else {
      rec.resume();
      pausado = false;
      iniciarTimer();
      $("btnPausa").textContent = "⏸ Pausa";
      estadoGrabacion("Grabando sesión...");
    }
  }

  function limpiarSesion() {
    try { if (loc[1].src && masterNode) loc[1].src.disconnect(masterNode); } catch (e) {}
    try { if (loc[2].src && masterNode) loc[2].src.disconnect(masterNode); } catch (e) {}
    try { if (musicaConectada && musicGainNode && masterNode) musicGainNode.disconnect(masterNode); } catch (e) {}
    musicaConectada = false;
    if (timerInt) clearInterval(timerInt);
    anMaster = null;
    masterNode = null;
    const c = $("eqMaster");
    if (c) c.getContext("2d").clearRect(0, 0, c.width, c.height);
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

      await cargarTodo();
    } catch (error) {
      console.error(error);
      estadoGrabacion("Error al guardar.", true);
    }
  }

  // ======================================================
  // TABLA / EDITAR / BORRAR
  // ======================================================

  async function cargarAudios() {
    if (!db) return;
    const { data, error } = await db.from("audios").select("*").order("creado_en", { ascending: false });
    if (error) { estadoGrabacion("Error al cargar: " + error.message, true); return; }
    audios = data || [];
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
    await cargarTodo();
  }

  async function togglePublicar(id) {
    const item = audios.find(a => a.id === id);
    if (!item) return;
    await db.from("audios").update({ publicado: !(item.publicado !== false) }).eq("id", id);
    await cargarTodo();
  }

  async function borrarAudio(id) {
    const item = audios.find(a => a.id === id);
    if (!item || !confirm(`¿Borrar "${item.titulo}"?`)) return;
    if (item.archivo) await db.storage.from("audios").remove([item.archivo]);
    await db.from("audios").delete().eq("id", id);
    detenerReproduccion();
    await cargarTodo();
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

  function extDesdeNombre(n) {
    const m = n.match(/\.([a-z0-9]+)$/i);
    return m ? m[1].toLowerCase() : "mp3";
  }
})();
