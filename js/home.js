(function () {
  "use strict";

  const config = {
    url: window.SUPABASE_URL,
    key: window.SUPABASE_ANON_KEY
  };

  if (!window.supabase || !config.url || config.url.includes("PEGAR")) {
    document.getElementById("playerEstado").textContent = "Configura Supabase primero.";
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

    // Cargar episodio aleatorio
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

    // Actualizar UI
    playerTitulo.textContent = episodio.titulo;
    playerAlumno.textContent = `🎤 ${episodio.alumno || "Anónimo"}`;
    playerCategoria.textContent = episodio.categoria || "General";

    // Imagen
    if (episodio.imagen) {
      playerImg.src = episodio.imagen;
      playerImg.style.display = "block";
      playerPlaceholder.style.display = "none";
    } else {
      playerImg.style.display = "none";
      playerPlaceholder.style.display = "flex";
    }

    // Audio
    playerAudio.src = episodio.url;
    playerAudio.muted = true; // Autoplay muted por políticas del navegador

    playerAudio.play()
      .then(() => {
        playerEstado.textContent = "Reproduciendo (silenciado - haz clic en 'Activar sonido')";
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

  // Eventos
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
    // Cuando termina, cargar otro aleatorio
    reproducirAleatorio();
  });

  playerAudio.addEventListener("play", () => actualizarIconoPlay(true));
  playerAudio.addEventListener("pause", () => actualizarIconoPlay(false));
})();