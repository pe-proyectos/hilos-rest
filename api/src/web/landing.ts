// Landing de hilos.rest. Es la cara pública del motor: quien llega aquí es
// alguien que está decidiendo si enchufarlo a su producto, así que manda la
// claridad — qué resuelve, cómo se usa y quién lo tiene ya en producción.

interface Stats {
  pages: number
  posts: number
  comments: number
}

const n = (v: number) => v.toLocaleString('es')

export function landingHtml(stats: Stats | null): string {
  return `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>hilos.rest — el motor social para tu producto</title>
<meta name="description" content="Perfiles, publicaciones, comentarios, seguimientos y mensajes con una API. Añade una capa social a tu producto sin construirla desde cero.">
<meta name="color-scheme" content="light dark">
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Ctext y='25' font-size='26'%3E%E2%97%8F%3C/text%3E%3C/svg%3E">
<meta property="og:title" content="hilos.rest — el motor social para tu producto">
<meta property="og:description" content="Perfiles, publicaciones, comentarios, seguimientos y mensajes con una API.">
<meta property="og:type" content="website">
<meta property="og:url" content="https://hilos.rest">
<style>
  :root {
    --bg: #fbfbfd; --surface: #fff; --ink: #0d1220; --ink-2: #5a6475; --ink-3: #98a1b2;
    --line: #e7e9f0; --accent: #4f46e5; --accent-soft: #eef0fe;
    --code-bg: #0f1220; --code-ink: #e6e8f0; --code-key: #a5b4fc; --code-str: #86efac; --code-com: #6b7280;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #0a0c14; --surface: #11141f; --ink: #edeff5; --ink-2: #a1a9bb; --ink-3: #6c7488;
      --line: #1e2333; --accent: #8b8cf9; --accent-soft: #191c35;
      --code-bg: #070910; --code-ink: #e6e8f0;
    }
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; background: var(--bg); color: var(--ink);
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Inter, system-ui, sans-serif;
    line-height: 1.6; -webkit-font-smoothing: antialiased; letter-spacing: -0.011em;
  }
  a { color: inherit; }
  .wrap { max-width: 1040px; margin: 0 auto; padding: 0 24px; }

  header { padding: 22px 0; border-bottom: 1px solid var(--line); position: sticky; top: 0; background: color-mix(in srgb, var(--bg) 88%, transparent); backdrop-filter: blur(12px); z-index: 10; }
  .bar { display: flex; align-items: center; justify-content: space-between; gap: 16px; }
  .logo { display: flex; align-items: center; gap: 10px; font-weight: 650; font-size: 17px; text-decoration: none; }
  .dot { width: 11px; height: 11px; border-radius: 999px; background: var(--accent); box-shadow: 0 0 0 4px var(--accent-soft); }
  .nav { display: flex; gap: 22px; font-size: 14px; color: var(--ink-2); }
  .nav a { text-decoration: none; }
  .nav a:hover { color: var(--ink); }
  @media (max-width: 640px) { .nav { display: none; } }

  .hero { padding: 96px 0 72px; }
  .eyebrow { font-size: 12px; font-weight: 600; letter-spacing: .09em; text-transform: uppercase; color: var(--accent); margin: 0 0 18px; }
  h1 { font-size: clamp(38px, 6.2vw, 68px); line-height: 1.03; letter-spacing: -0.035em; font-weight: 640; margin: 0 0 20px; max-width: 15ch; }
  .lead { font-size: clamp(17px, 2vw, 21px); color: var(--ink-2); max-width: 62ch; margin: 0 0 32px; }
  .cta { display: flex; gap: 12px; flex-wrap: wrap; }
  .btn { display: inline-flex; align-items: center; gap: 8px; padding: 13px 22px; border-radius: 10px; font-size: 15px; font-weight: 560; text-decoration: none; transition: transform .15s ease, opacity .15s ease; }
  .btn:hover { transform: translateY(-1px); }
  .btn-primary { background: var(--accent); color: #fff; }
  .btn-ghost { border: 1px solid var(--line); color: var(--ink); background: var(--surface); }

  .stats { display: flex; gap: 40px; flex-wrap: wrap; padding: 28px 0 0; border-top: 1px solid var(--line); margin-top: 56px; }
  .stat b { display: block; font-size: 26px; font-weight: 620; letter-spacing: -0.02em; }
  .stat span { font-size: 13px; color: var(--ink-3); }

  section { padding: 72px 0; border-top: 1px solid var(--line); }
  h2 { font-size: clamp(26px, 3.4vw, 36px); letter-spacing: -0.028em; font-weight: 620; margin: 0 0 12px; }
  .sub { color: var(--ink-2); max-width: 60ch; margin: 0 0 40px; }

  .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: 16px; }
  .card { background: var(--surface); border: 1px solid var(--line); border-radius: 14px; padding: 22px; }
  .card h3 { margin: 0 0 6px; font-size: 16px; font-weight: 600; }
  .card p { margin: 0; font-size: 14.5px; color: var(--ink-2); }
  .card code { font-size: 12.5px; color: var(--accent); background: var(--accent-soft); padding: 2px 7px; border-radius: 6px; }

  pre { background: var(--code-bg); color: var(--code-ink); border-radius: 14px; padding: 22px; overflow-x: auto; font-size: 13.5px; line-height: 1.65; margin: 0; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
  .k { color: var(--code-key); } .s { color: var(--code-str); } .c { color: var(--code-com); }
  .cols { display: grid; grid-template-columns: 1fr 1fr; gap: 18px; align-items: start; }
  @media (max-width: 860px) { .cols { grid-template-columns: 1fr; } }

  .steps { counter-reset: paso; display: grid; gap: 14px; }
  .step { display: flex; gap: 16px; align-items: flex-start; }
  .step::before { counter-increment: paso; content: counter(paso); flex: none; width: 26px; height: 26px; border-radius: 999px; background: var(--accent-soft); color: var(--accent); font-size: 13px; font-weight: 650; display: grid; place-items: center; margin-top: 2px; }
  .step p { margin: 0; color: var(--ink-2); font-size: 15px; }
  .step b { color: var(--ink); font-weight: 580; }

  footer { padding: 44px 0 64px; border-top: 1px solid var(--line); color: var(--ink-3); font-size: 14px; display: flex; justify-content: space-between; gap: 20px; flex-wrap: wrap; }
  footer a { color: var(--ink-2); text-decoration: none; }
  footer a:hover { color: var(--ink); }
</style>
</head>
<body>

<header>
  <div class="wrap bar">
    <a class="logo" href="/"><span class="dot"></span> hilos<span style="color:var(--ink-3)">.rest</span></a>
    <nav class="nav">
      <a href="#primitivas">Primitivas</a>
      <a href="#empezar">Empezar</a>
      <a href="#seguridad">Seguridad</a>
      <a href="#quien">Quién lo usa</a>
    </nav>
  </div>
</header>

<div class="wrap">
  <div class="hero">
    <p class="eyebrow">API social como servicio</p>
    <h1>La capa social de tu producto, ya construida.</h1>
    <p class="lead">
      Perfiles, publicaciones, comentarios anidados, me gusta, seguimientos y mensajes directos.
      Una API que enchufas a lo que ya tienes, en lugar de dedicar meses a reinventar lo mismo de siempre.
    </p>
    <div class="cta">
      <a class="btn btn-primary" href="#empezar">Ver cómo se usa</a>
      <a class="btn btn-ghost" href="/v1/health">Estado del servicio</a>
    </div>

    ${stats ? `
    <div class="stats">
      <div class="stat"><b>${n(stats.pages)}</b><span>perfiles activos</span></div>
      <div class="stat"><b>${n(stats.posts)}</b><span>publicaciones</span></div>
      <div class="stat"><b>${n(stats.comments)}</b><span>comentarios</span></div>
      <div class="stat"><b>99.9%</b><span>en producción desde 2026</span></div>
    </div>` : ''}
  </div>
</div>

<section id="primitivas">
  <div class="wrap">
    <h2>Seis primitivas, nada más</h2>
    <p class="sub">Todo lo social se construye combinando estas piezas. No hay conceptos de más.</p>
    <div class="grid">
      <div class="card"><h3>Page</h3><p>Un perfil: una persona, una marca, un producto. Admite subpáginas, así que una tienda puede colgar de una empresa. <code>@handle</code> único.</p></div>
      <div class="card"><h3>Post</h3><p>Contenido publicado por una page en el muro de otra. Con eso salen feeds, muros y publicaciones automáticas desde tu backend.</p></div>
      <div class="card"><h3>Comment</h3><p>Conversación anidada sobre un post, paginada y ordenable. Con moderación reversible: ocultar nunca borra.</p></div>
      <div class="card"><h3>Reaction</h3><p>Me gusta sobre posts y comentarios, y guardados privados por page.</p></div>
      <div class="card"><h3>Follow</h3><p>Seguimientos que alimentan el feed personal y las sugerencias de a quién seguir.</p></div>
      <div class="card"><h3>Message</h3><p>Mensajería directa con reglas de acceso propias: tú decides quién puede escribir y quién puede leer.</p></div>
    </div>
  </div>
</section>

<section id="empezar">
  <div class="wrap">
    <h2>Tres llamadas y ya tienes conversación</h2>
    <p class="sub">Sin SDK obligatorio ni configuración previa. Una clave y peticiones HTTP normales.</p>
    <div class="cols">
      <pre><span class="c"># 1. Cada usuario tuyo es una page</span>
curl -X POST https://hilos.rest/v1/pages \\
  -H <span class="s">"Authorization: Bearer sk_live_..."</span> \\
  -d <span class="s">'{"externalId":"user:42",
       "handle":"ana",
       "displayName":"Ana"}'</span>

<span class="c"># 2. Publica en su nombre</span>
curl -X POST https://hilos.rest/v1/posts \\
  -H <span class="s">"Authorization: Bearer sk_live_..."</span> \\
  -H <span class="s">"X-Hilos-Page: external:user:42"</span> \\
  -d <span class="s">'{"content":"Hola mundo"}'</span></pre>
      <pre><span class="c">// 3. Y en el navegador, con un token
// de corta vida que emites tú</span>
<span class="k">const</span> token = <span class="k">await</span> miBackend.pedirToken()

<span class="k">await</span> fetch(<span class="s">'https://hilos.rest/v1/posts/12/comments'</span>, {
  method: <span class="s">'POST'</span>,
  headers: { Authorization: <span class="s">'Bearer ' + token</span> },
  body: JSON.stringify({ content: <span class="s">'Buenísimo'</span> }),
})

<span class="c">// La secret key nunca sale de tu servidor.</span></pre>
    </div>
  </div>
</section>

<section id="seguridad">
  <div class="wrap">
    <h2>Pensado para que el navegador no te traicione</h2>
    <p class="sub">El patrón que ya usan las apps en producción sobre hilos, sin que tengas que inventarlo.</p>
    <div class="steps">
      <div class="step"><p><b>Claves separadas.</b> La secret key vive en tu servidor. La publicable solo lee. Para escribir desde el navegador se emiten tokens de página con 15 minutos de vida.</p></div>
      <div class="step"><p><b>Permisos por token.</b> Cada token lleva sus ámbitos: leer, publicar, comentar, reaccionar, seguir. Un token de comentarios no puede publicar.</p></div>
      <div class="step"><p><b>Orígenes permitidos.</b> Defines desde qué dominios se acepta tu app; el resto se rechaza en el propio motor.</p></div>
      <div class="step"><p><b>Revocación y límites.</b> Tokens revocables uno a uno y límites de frecuencia por página, para que un abuso no se lleve por delante tu servicio.</p></div>
      <div class="step"><p><b>Eventos firmados.</b> Webhooks con HMAC cuando pasa algo, para que tu backend reaccione: avisar por correo, moderar, lo que necesites.</p></div>
    </div>
  </div>
</section>

<section id="quien">
  <div class="wrap">
    <h2>En producción, no en una demo</h2>
    <p class="sub">hilos nació para resolver un problema real y hoy sostiene dos productos con tráfico.</p>
    <div class="grid">
      <div class="card">
        <h3><a href="https://lacharca.com" style="text-decoration:none">La Charca ↗</a></h3>
        <p>Una red social completa construida entera sobre hilos: feed, perfiles, chat, avisos y guardados. Sin base de datos social propia.</p>
      </div>
      <div class="card">
        <h3><a href="https://capibaratraductor.com" style="text-decoration:none">CapibaraTraductor ↗</a></h3>
        <p>Un lector de manga con miles de lectores diarios. Sus comentarios viven en hilos y se muestran dentro del lector.</p>
      </div>
      <div class="card">
        <h3>¿Y el tuyo?</h3>
        <p>Si tu producto necesita que la gente hable entre sí, esto ya está hecho. Escribe y te damos acceso.</p>
      </div>
    </div>
  </div>
</section>

<div class="wrap">
  <footer>
    <span>hilos.rest · motor social multi-tenant</span>
    <span>
      <a href="/v1/health">Estado</a> ·
      <a href="https://lacharca.com">La Charca</a> ·
      <a href="https://capibaratraductor.com">CapibaraTraductor</a>
    </span>
  </footer>
</div>

</body>
</html>`
}
