(function () {
  "use strict";

  const config = {
    url: window.SUPABASE_URL,
    key: window.SUPABASE_ANON_KEY
  };

  if (!window.supabase || !config.url || config.url.includes("PEGAR")) {
    const est = document.getElementById("playerEstado");
    if (est) est.textContent = "Configura Supabase primero.";
    return;
  }

  const db = window.supabase.createClient(config.url, config.key);

  const $ = (id) => document.getElementById(id);

  const playerAudio = $("playerAudio");
  const playerImg = $("playerImg");
  const playerPlaceholder = $("playerPlaceholder");
  const playerTitulo = $("playerTitulo");
  const playerAlumno = $("playerAlumno");
  const playerCategoria = $("playerCategoria");
  const playerEstado = $("playerEstado");

  const btnPlayPause = $("btnPlayPause");
  const btnMute = $("btnMute");
  const btnSiguiente = $("btnSiguiente");

  // Bloquear descarga
  playerAudio.setAttribute("controlslist", "nodownload");

  let episodios = [];
  let indiceActual = -1;

  cargarEpisodios();

  async function cargarEpisodios() {
    playerEstado.textContent = "Cargando episodios...";

    const { data, error } = await db
      .from("audios")
      .select("*")
      .eq("publicado", true)
      .order("creado_en", { ascending: false });

    if (error) {
      playerEstado.textContent = "Error al cargar episodios.";
      return;
    }

    episodios = data || [];

    if (!episodios.length) {
      playerEstado.textContent = "No hay episodios publicados todavía.";
      return;
    }

    btnPlayPause.disabled = false;
    btnMute.disabled = false;
    btnSiguiente.disabled = false;

    reproducirAleatorio();
  }

  function reproducirAleatorio() {
    if (!episodios.length) return;

    let nuevoIndice;
    do {
      nuevoIndice = Math.floor(Math.random() * episodios.length);
    } while (nuevoIndice === indiceActual && episodios.length > 1);

    indiceActual = nuevoIndice;
    const episodio = episodios[indiceActual];

    playerTitulo.textContent = episodio.titulo;
    playerAlumno.textContent = `🎤 ${episodio.alumno || "Anónimo"}`;
    playerCategoria.textContent = episodio.categoria || "General";

    if (episodio.imagen) {
      playerImg.src = episodio.imagen;
      playerImg.style.display = "block";
      playerPlaceholder.style.display = "none";
    } else {
      playerImg.style.display = "none";
      playerPlaceholder.style.display = "flex";
    }

    playerAudio.src = episodio.url;
    playerAudio.muted = true;

    playerAudio.play()
      .then(() => {
        playerEstado.textContent = "Reproduciendo (silenciado - pulsa 'Activar sonido')";
        actualizarIconoPlay(true);
      })
      .catch(() => {
        playerEstado.textContent = "Haz clic en ▶ para reproducir";
        actualizarIconoPlay(false);
      });
  }

  function actualizarIconoPlay(reproduciendo) {
    const icon = btnPlayPause.querySelector(".icon-play");
    icon.textContent = reproduciendo ? "⏸" : "▶";
  }

  btnPlayPause.addEventListener("click", () => {
    if (playerAudio.paused) {
      playerAudio.play();
      actualizarIconoPlay(true);
    } else {
      playerAudio.pause();
      actualizarIconoPlay(false);
    }
  });

  btnMute.addEventListener("click", () => {
    playerAudio.muted = !playerAudio.muted;
    btnMute.textContent = playerAudio.muted ? "🔇 Activar sonido" : "🔊 Silenciar";
    playerEstado.textContent = playerAudio.muted
      ? "Reproduciendo (silenciado)"
      : "Reproduciendo con sonido";
  });

  btnSiguiente.addEventListener("click", reproducirAleatorio);

  playerAudio.addEventListener("ended", () => {
    reproducirAleatorio();
  });

  playerAudio.addEventListener("play", () => actualizarIconoPlay(true));
  playerAudio.addEventListener("pause", () => actualizarIconoPlay(false));
})();