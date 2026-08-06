(function () {
  "use strict";

  const config = { url: window.SUPABASE_URL, key: window.SUPABASE_ANON_KEY };
  if (!window.supabase || !config.url || config.url.includes("PEGAR")) return;

  const db = window.supabase.createClient(config.url, config.key);

  cargar();

  async function cargar() {
    const { data, error } = await db.from("audios").select("*");
    if (error) {
      document.getElementById("statsGrid").innerHTML = "<p>Error al cargar.</p>";
      return;
    }

    const todos = data || [];

    // ===== Totales =====
    const totalPlays = todos.reduce((s, e) => s + (e.reproducciones || 0), 0);
    const totalLikes = todos.reduce((s, e) => s + (e.likes || 0), 0);
    const totalSeg = todos.reduce((s, e) => s + (e.duracion || 0), 0);

    document.getElementById("statsGrid").innerHTML = `
      <div class="stat-card"><div class="stat-num">${todos.length}</div><div class="stat-label">Episodios</div></div>
      <div class="stat-card"><div class="stat-num">${totalPlays}</div><div class="stat-label">Reproducciones</div></div>
      <div class="stat-card"><div class="stat-num">${totalLikes}</div><div class="stat-label">Likes</div></div>
      <div class="stat-card"><div class="stat-num">${formatearTiempo(totalSeg)}</div><div class="stat-label">Tiempo grabado</div></div>
    `;

    // ===== Top 5 =====
    const top = [...todos]
      .sort((a, b) => (b.reproducciones || 0) - (a.reproducciones || 0))
      .slice(0, 5);

    const tbody = document.getElementById("topTabla");
    tbody.innerHTML = "";

    if (!top.length) {
      tbody.innerHTML = "<tr><td colspan='5'>Sin datos todavía.</td></tr>";
    } else {
      top.forEach((e, i) => {
        const tr = document.createElement("tr");
        tr.innerHTML = `
          <td>${i + 1}</td>
          <td>${e.titulo}</td>
          <td>${e.alumno || "Anónimo"}</td>
          <td>${e.reproducciones || 0}</td>
          <td>${e.likes || 0}</td>
        `;
        tbody.appendChild(tr);
      });
    }

    // ===== Por categoría =====
    const porCat = {};
    todos.forEach(e => {
      const c = e.categoria || "General";
      porCat[c] = (porCat[c] || 0) + (e.reproducciones || 0);
    });

    const maxCat = Math.max(...Object.values(porCat), 1);
    const barras = document.getElementById("barrasCategoria");
    barras.innerHTML = "";

    Object.entries(porCat).sort((a, b) => b[1] - a[1]).forEach(([cat, val]) => {
      const pct = Math.round((val / maxCat) * 100);
      barras.innerHTML += `
        <div class="bar-row">
          <div class="bar-label"><span>${cat}</span><span>${val} plays</span></div>
          <div class="bar-track"><div class="bar-fill" style="width:${pct}%"></div></div>
        </div>
      `;
    });

    // ===== Por temporada =====
    const porTemp = {};
    todos.forEach(e => {
      const t = e.temporada || "Sin temporada";
      porTemp[t] = (porTemp[t] || 0) + 1;
    });

    const listaT = document.getElementById("listaTemporadas");
    listaT.innerHTML = "";

    Object.entries(porTemp).forEach(([temp, count]) => {
      listaT.innerHTML += `
        <div class="bar-row">
          <div class="bar-label"><span>🗓️ ${temp}</span><span>${count} episodio(s)</span></div>
        </div>
      `;
    });
  }

  function formatearTiempo(seg) {
    const h = Math.floor(seg / 3600);
    const m = Math.floor((seg % 3600) / 60);
    return h > 0 ? `${h}h ${m}m` : `${m} min`;
  }
})();