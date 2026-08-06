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

    // Al abrir la página: reproduciendo SIN sonido,
    // GIF visible y mensaje "¡Activa el audio!"
    audio.muted = true;
    setGif(true);
    setVibracion(true);
    aleatorio();
  }

  // ===== Poner una pista =====
  function cargarPista(n) {
    indice = n;
    const item = pool[indice];
    titulo.textContent = item.titulo;
    meta.textContent = item._tipo === "m"
      ? "🎵 Música · Biblioteca Podcast 21"
      : `🎤 ${item.alumno || "Anónimo"} · ${item.categoria || "General"}`;

    audio.src = item.url;
    audio.play()
      .then(() => { btnPlay.textContent = "⏸"; })
      .catch(() => { btnPlay.textContent = "▶"; });
  }

  // ===== Pista siguiente aleatoria =====
  function aleatorio() {
    let n;
    do { n = Math.floor(Math.random() * pool.length); }
    while (n === indice && pool.length > 1);
    if (indice >= 0) historial.push(indice);
    cargarPista(n);
  }

  // ===== Pista anterior =====
  function anterior() {
    if (!historial.length) return;
    cargarPista(historial.pop());
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

  // ===== Bocina vibrante + aviso =====
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
    if (audio.paused) { audio.play(); btnPlay.textContent = "⏸"; }
    else { audio.pause(); btnPlay.textContent = "▶"; }
  });

  btnNext.addEventListener("click", aleatorio);

  btnMute.addEventListener("click", () => {
    audio.muted = !audio.muted;
    btnMute.textContent = audio.muted ? "🔇" : "🔊";
    setVibracion(audio.muted);
  });

  audio.addEventListener("play", () => { btnPlay.textContent = "⏸"; setGif(true); });
  audio.addEventListener("pause", () => { btnPlay.textContent = "▶"; });
  audio.addEventListener("ended", aleatorio);
})();