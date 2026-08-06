(function () {
  "use strict";

  const config = { url: window.SUPABASE_URL, key: window.SUPABASE_ANON_KEY };
  if (!window.supabase || !config.url || config.url.includes("PEGAR")) return;

  const db = window.P21_DB || window.supabase.createClient(config.url, config.key);

  const $ = (id) => document.getElementById(id);

  const audio = $("pmAudio");
  const titulo = $("pmTitulo");
  const meta = $("pmMeta");
  const btnPrev = $("pmPrev");
  const btnPlay = $("pmPlay");
  const btnNext = $("pmNext");
  const btnMute = $("pmMute");
  const aviso = $("pmAviso");
  const gif = $("pmGif");

  let pool = [];
  let indice = -1;
  let historial = [];
  let desbloqueoActivo = false;

  cargar();

  // ===== Carga episodios Y música =====
  async function cargar() {
    const [rAud, rMus] = await Promise.all([
      db.from("audios").select("*").eq("publicado", true).order("creado_en", { ascending: false }),
      db.from("musica").select("*").order("creado_en", { ascending: false })
    ]);

    const episodios = rAud.data || [];
    const musicas = rMus.data || [];

    pool = [
      ...musicas.map(m => ({ ...m, _tipo: "m" })),
      ...episodios.map(e => ({ ...e, _tipo: "e" }))
    ];

    if (!pool.length) {
      titulo.textContent = "Aún no hay contenido";
      meta.textContent = "Sube música o graba episodios desde la cabina 🎙️";
      return;
    }

    btnPrev.disabled = false;
    btnPlay.disabled = false;
    btnNext.disabled = false;
    btnMute.disabled = false;

    // AL ABRIR: pista activa y MUTEADA, GIF visible y aviso "¡Activa el audio!"
    audio.muted = true;
    setGif(true);
    setVibracion(true);
    aleatorio(true);
  }

  // ===== Poner una pista =====
  function cargarPista(n, reproducir) {
    indice = n;
    const item = pool[indice];
    titulo.textContent = item.titulo;
    meta.textContent = item._tipo === "m"
      ? "🎵 Música · Biblioteca Podcast 21"
      : `🎤 ${item.alumno || "Anónimo"} · ${item.categoria || "General"}`;

    audio.src = item.url;

    if (reproducir) {
      intentarReproduccion();
    } else {
      btnPlay.textContent = "▶";
    }
  }

  // ===== Reproducir con reintentos automáticos =====
  function intentarReproduccion() {
    const prom = audio.play();
    if (!prom) return;

    prom
      .then(() => { btnPlay.textContent = "⏸"; })
      .catch((err) => {
        console.warn("Autoplay bloqueado por el navegador:", err && err.name);
        btnPlay.textContent = "▶";
        reintentarCuandoListo();
        prepararDesbloqueo();
      });
  }

  function reintentarCuandoListo() {
    audio.addEventListener("canplay", function h() {
      audio.removeEventListener("canplay", h);
      audio.play()
        .then(() => { btnPlay.textContent = "⏸"; })
        .catch(() => {});
    });
  }

  // Si el navegador bloquea incluso el muteado: cualquier clic o tecla
  // en la página arranca la reproducción (sigue muteada hasta activar audio)
  function prepararDesbloqueo() {
    if (desbloqueoActivo) return;
    desbloqueoActivo = true;
    const fn = () => {
      window.removeEventListener("pointerdown", fn);
      window.removeEventListener("keydown", fn);
      desbloqueoActivo = false;
      audio.play()
        .then(() => { btnPlay.textContent = "⏸"; })
        .catch(() => {});
    };
    window.addEventListener("pointerdown", fn);
    window.addEventListener("keydown", fn);
  }

  // ===== Siguiente aleatoria =====
  function aleatorio(reproducir) {
    let n;
    do { n = Math.floor(Math.random() * pool.length); }
    while (n === indice && pool.length > 1);
    if (indice >= 0) historial.push(indice);
    cargarPista(n, reproducir);
  }

  // ===== Anterior =====
  function anterior() {
    if (!historial.length) return;
    cargarPista(historial.pop(), !audio.paused);
  }

  // ===== GIF =====
  function setGif(activo) {
    if (!gif) return;
    if (activo) {
      gif.src = "img/radio-anim.gif";
      gif.classList.remove("oculto");
    } else {
      gif.classList.add("oculto");
      gif.src = "";
    }
  }

  // ===== Bocina vibrante + mensaje (visible mientras esté muteado) =====
  function setVibracion(activo) {
    if (activo) {
      btnMute.classList.add("vibrando");
      aviso.classList.remove("oculto");
    } else {
      btnMute.classList.remove("vibrando");
      aviso.classList.add("oculto");
    }
  }

  // ===== Controles =====
  btnPrev.addEventListener("click", anterior);

  btnPlay.addEventListener("click", () => {
    if (audio.paused) {
      audio.play()
        .then(() => { btnPlay.textContent = "⏸"; })
        .catch(() => {});
    } else {
      audio.pause();
      btnPlay.textContent = "▶";
    }
  });

  btnNext.addEventListener("click", () => aleatorio(!audio.paused));

  // LA BOCINA: un clic activa el sonido (sin tocar el play)
  btnMute.addEventListener("click", () => {
    audio.muted = !audio.muted;
    btnMute.textContent = audio.muted ? "🔇" : "🔊";
    setVibracion(audio.muted);
  });

  audio.addEventListener("play", () => { btnPlay.textContent = "⏸"; setGif(true); });
  audio.addEventListener("pause", () => { btnPlay.textContent = "▶"; });
  audio.addEventListener("ended", () => aleatorio(true));
})();