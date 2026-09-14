// ======================================================
// CONFIGURACIÓN DE SUPABASE
// Secundaria 21 de Noviembre - Esquipulas
// powered by elprofechan
// ======================================================

window.SUPABASE_URL = "https://kcynhfufhrkbuleapfro.supabase.co";
window.SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImtjeW5oZnVmaHJrYnVsZWFwZnJvIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODU5NzA3MjEsImV4cCI6MjEwMTU0NjcyMX0.49_qsBBjorhYMqovo2OBTRZ9BB_Wl-OdFS-MEjBJSOs";

window.JITSI_ROOM = "Cabina21NovProfechan";

// URL del Worker de Cloudflare que sube archivos a Backblaze B2.
// La obtienes al correr "wrangler deploy" en cloudflare-worker/
window.B2_WORKER_URL = "https://podcast21-uploads.elprofechan.workers.dev";

// ======================================================
// CONEXIÓN ÚNICA COMPARTIDA
// Crea UNA sola instancia de Supabase para toda la página.
// Esto elimina la advertencia "Multiple GoTrueClient instances".
// ======================================================
if (window.supabase && window.SUPABASE_URL && !window.SUPABASE_URL.includes("PEGAR")) {
  if (!window.P21_DB) {
    window.P21_DB = window.supabase.createClient(window.SUPABASE_URL, window.SUPABASE_ANON_KEY);
  }
}
