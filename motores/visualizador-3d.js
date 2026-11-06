/*!
 * Motor 3D — visualizador de estruturas e resultados de elementos finitos
 * Conjunto "Cálculo Estrutural" · versão 1.2 · nov/2026
 *
 * Motor genérico, sem nada específico de um programa. Desenha:
 *   - superfícies de casca (quadriláteros ou triângulos) com mapa de cores por nó e deformada;
 *   - sólidos extrudados (lajes, paredes, solo) a partir de um contorno em planta;
 *   - setas de carregamento; linhas;
 *   - corte por um plano, zoom, ajuste de vista e leitura do valor no ponto clicado.
 *
 * Convenção de eixos (a mesma do motor de elementos finitos): x e y horizontais, z vertical para cima.
 * Unidades livres (o motor não converte nada); as legendas recebem a unidade como texto.
 *
 * Dependências: three.js r128 (global THREE) e OrbitControls r128. Motor3D.carregar() busca os dois
 * nos CDNs permitidos se ainda não estiverem na página.
 *
 * Uso mínimo:
 *   await Motor3D.carregar();
 *   const v = Motor3D.criar(document.getElementById('caixa'));
 *   const esc = Motor3D.escala(valores, { tipo: 'divergente' });
 *   v.superficie({ nos, quads, valores, escala: esc });
 *   v.ajustar();
 *   legenda.innerHTML = Motor3D.legendaHTML(esc, 'kN·m/m');
 *
 * Documentação completa: motores/LEIAME.md
 */
(function (global) {
  'use strict';
  const VERSAO = '1.2';
  const THREE_URL = 'https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.min.js';
  const ORBIT_URL = 'https://cdn.jsdelivr.net/npm/three@0.128.0/examples/js/controls/OrbitControls.js';

  /* ---------------- utilidades ---------------- */
  function script(src) {
    return new Promise((res, rej) => {
      const s = document.createElement('script'); s.src = src; s.onload = res;
      s.onerror = () => rej(new Error('Não foi possível carregar ' + src)); document.head.appendChild(s);
    });
  }
  let carga = null;
  function carregar() {
    if (!carga) carga = (global.THREE ? Promise.resolve() : script(THREE_URL))
      .then(() => (global.THREE.OrbitControls ? null : script(ORBIT_URL)))
      .catch(e => { carga = null; throw e; });
    return carga;
  }
  // cor CSS (#rrggbb, #rgb, rgb(), ou nome de variável --x) em [r,g,b] 0..255
  function rgb(c, fb) {
    try {
      if (c && c.startsWith('--')) c = getComputedStyle(document.documentElement).getPropertyValue(c).trim();
      let m = /^#([0-9a-f]{6})$/i.exec(c); if (m) return [0, 2, 4].map(k => parseInt(m[1].slice(k, k + 2), 16));
      m = /^#([0-9a-f]{3})$/i.exec(c); if (m) return [0, 1, 2].map(k => 17 * parseInt(m[1][k], 16));
      m = /rgba?\(([^)]+)\)/.exec(c); if (m) return m[1].split(',').slice(0, 3).map(Number);
    } catch (e) {}
    return fb || [128, 128, 128];
  }
  const hex = c => '#' + c.map(v => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, '0')).join('');
  const mix = (a, b, t) => [0, 1, 2].map(k => a[k] + (b[k] - a[k]) * t);
  // engenharia (x, y, z↑) → three (x, y↑, −z)
  const P3 = (x, y, z) => [x, z, -y];

  /* ---------------- escalas de cor ---------------- */
  // Arco-íris de engenharia, do menor para o maior valor: o maior esforço fica vermelho.
  const ARCO = ['#3949ab', '#1e88e5', '#29b6f6', '#26c6da', '#26a69a', '#66bb6a', '#9ccc65', '#d4e157', '#ffee58', '#ffca28', '#ffa726', '#fb8c00', '#f4511e', '#d32f2f'];
  // Para valores de um só sinal (0 → máx): começa num tom claro e escurece até o vermelho.
  const ARCO_CLARO = ['#e8eaf6', '#bbdefb', '#81d4fa', '#80deea', '#80cbc4', '#a5d6a7', '#c5e1a5', '#e6ee9c', '#fff59d', '#ffe082', '#ffcc80', '#ffab40', '#ff7043', '#d32f2f'];
  function rampa(lista) {
    const cs = lista.map(c => rgb(c));
    return t => { t = Math.max(0, Math.min(1, t)) * (cs.length - 1); const i = Math.min(cs.length - 2, Math.floor(t)); return mix(cs[i], cs[i + 1], t - i); };
  }
  /**
   * Monta a escala de cores para uma lista de valores.
   * opts.tipo:
   *   'arco-iris'  — várias cores, do menor (azul, ou tom claro quando o mínimo é 0) ao maior (vermelho);
   *                  opts.faixas (padrão 12) dá faixas de cor nítidas, como os programas de análise; faixas: 0 = contínuo;
   *   'divergente' — negativo · zero · positivo, simétrica em torno de zero (duas cores);
   *   'sequencial' — de zero ao máximo em uma cor.
   * opts.min / opts.max: limites fixos (senão, os extremos dos valores, ou opts.limites = [mín, máx] de uma região).
   * opts.cores: { neg, zero, pos } para as escalas de duas cores; opts.paleta: lista de cores para o arco-íris.
   */
  function escala(valores, opts) {
    opts = opts || {};
    let lo = Infinity, hi = -Infinity;
    const src = opts.limites || null;
    if (src) { lo = src[0]; hi = src[1]; }
    else for (let i = 0; i < valores.length; i++) { const v = valores[i]; if (Number.isFinite(v)) { if (v < lo) lo = v; if (v > hi) hi = v; } }
    if (!Number.isFinite(lo)) { lo = 0; hi = 0; }
    if (opts.min != null) lo = opts.min; if (opts.max != null) hi = opts.max;
    const tipo = opts.tipo || (lo < 0 && hi > 0 ? 'divergente' : 'sequencial');
    const amax = Math.max(Math.abs(lo), Math.abs(hi), 1e-12);
    const span = Math.max(hi - lo, 1e-12);
    if (tipo === 'arco-iris') {
      const faixas = opts.faixas == null ? 12 : Math.max(0, Math.round(opts.faixas));
      const claro = lo >= -1e-12;
      const rp = rampa(opts.paleta || (claro ? ARCO_CLARO : ARCO));
      const tOf = v => Math.max(0, Math.min(1, (v - lo) / span));
      // com faixas, cada faixa recebe a cor do seu centro
      const tq = t => faixas > 1 ? Math.min(faixas - 1, Math.floor(t * faixas)) / (faixas - 1) : t;
      const corFaixa = i => rp(faixas > 1 ? i / (faixas - 1) : 0.5);
      const cor = v => rp(tq(tOf(v)));
      return { tipo, min: lo, max: hi, amax, cor, t: tOf, faixas, rampa: rp, corFaixa };
    }
    const c = opts.cores || {};
    const neg = rgb(c.neg || '--neg', [43, 108, 176]), zero = rgb(c.zero || '#f7f8f9', [247, 248, 249]), pos = rgb(c.pos || '--pos', [192, 97, 42]);
    // rampa em 3 pontos: zero → cor → cor escurecida (mais contraste nos extremos, sem distorcer a escala)
    const dark = c => c.map(x => x * 0.62);
    const ramp = (c, t) => t <= 0.55 ? mix(zero, c, t / 0.55) : mix(c, dark(c), (t - 0.55) / 0.45);
    const cor = tipo === 'divergente'
      ? v => { const t = Math.max(-1, Math.min(1, v / amax)); return t >= 0 ? ramp(pos, t) : ramp(neg, -t); }
      : (hi <= 0 && lo < 0)
        ? v => ramp(neg, Math.max(0, Math.min(1, (hi - v) / span)))
        : v => ramp(pos, Math.max(0, Math.min(1, (v - lo) / span)));
    return { tipo, min: lo, max: hi, amax, cor, cores: { neg, zero, pos } };
  }
  const fmtPadrao = v => v.toLocaleString('pt-BR', { maximumFractionDigits: Math.abs(v) >= 100 ? 0 : Math.abs(v) >= 10 ? 1 : 2 });
  /**
   * HTML da legenda. Barra horizontal com os extremos (padrão) ou, com opts.vertical, coluna de faixas com os
   * valores nas divisas (máximo em cima), no estilo dos programas de análise. fmt(v) formata os números.
   */
  function legendaHTML(esc, unidade, fmt, opts) {
    fmt = fmt || fmtPadrao; opts = opts || {};
    if (esc.tipo === 'arco-iris' && opts.vertical) {
      const n = esc.faixas || 12, h = opts.altura || 15, H = n * h;
      let sw = '', lb = '';
      for (let i = 0; i < n; i++) sw += `<i style="background:${hex(esc.faixas ? esc.corFaixa(n - 1 - i) : esc.rampa((n - 1 - i + 0.5) / n))};height:${h}px"></i>`;
      for (let i = 0; i <= n; i++) lb += `<span style="top:${i * h - 6}px">${fmt(esc.max - (esc.max - esc.min) * i / n)}</span>`;
      return `<div class="m3-lv">${unidade ? `<div class="m3-lv-u">${unidade}</div>` : ''}<div class="m3-lv-c"><div class="m3-lv-s">${sw}</div><div class="m3-lv-l" style="height:${H}px">${lb}</div></div></div>`;
    }
    let stops, ticks;
    if (esc.tipo === 'arco-iris') {
      const n = esc.faixas || 0;
      stops = n ? Array.from({ length: n }, (_, i) => `${hex(esc.corFaixa(i))} ${i / n * 100}% ${(i + 1) / n * 100}%`).join(',')
        : Array.from({ length: 15 }, (_, i) => `${hex(esc.rampa(i / 14))} ${i / 14 * 100}%`).join(',');
      ticks = [esc.min, (esc.min + esc.max) / 2, esc.max];
    } else {
      const div = esc.tipo === 'divergente';
      const a = div ? -esc.amax : esc.min, b = div ? esc.amax : esc.max;
      stops = [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1].map(t => `${hex(esc.cor(a + (b - a) * t))} ${t * 100}%`).join(',');
      ticks = div ? [a, 0, b] : [a, (a + b) / 2, b];
    }
    return `<div class="m3-leg"><div class="m3-bar" style="background:linear-gradient(90deg,${stops})"></div>` +
      `<div class="m3-ticks">${ticks.map(t => `<span>${fmt(t)}</span>`).join('')}</div>` +
      (unidade ? `<div class="m3-un">${unidade}</div>` : '') + '</div>';
  }
  /** Estilo padrão das legendas (pode ser sobrescrito pela página). Chamado uma vez por criar(). */
  function estiloLegendas() {
    if (document.getElementById('m3-css')) return;
    const st = document.createElement('style'); st.id = 'm3-css';
    st.textContent = '.m3-leg{display:grid;gap:3px}.m3-bar{height:12px;border-radius:3px;border:1px solid rgba(0,0,0,.15)}' +
      '.m3-ticks{display:flex;justify-content:space-between;font:12px ui-monospace,Consolas,monospace}.m3-un{font-size:11.5px;opacity:.75}' +
      '.m3-lv{font:11px ui-monospace,Consolas,monospace;line-height:1;display:grid;gap:6px}.m3-lv-u{font-weight:600}' +
      '.m3-lv-c{display:flex;gap:6px}.m3-lv-s{display:flex;flex-direction:column;border:1px solid rgba(0,0,0,.2)}.m3-lv-s i{display:block;width:16px}' +
      '.m3-lv-l{position:relative;min-width:44px}.m3-lv-l span{position:absolute;left:0;white-space:nowrap}';
    document.head.appendChild(st);
  }

  /* ---------------- geometria auxiliar (sem three) ---------------- */
  /**
   * Espelha uma malha por planos de simetria x = 0 e/ou y = 0.
   * malha: { nos: [[x,y,z]], quads: [[a,b,c,d]], ...campos por nó }
   * planos: lista de [sx, sy] (ex.: [[1,1],[-1,1],[1,-1],[-1,-1]] para 1/4 → inteira).
   * campo(nomeCampo, valor, sx, sy, indiceNo) devolve o valor espelhado (troca de sinal, componente etc.).
   * Devolve { nos, quads, origem: índice do nó original de cada nó novo, imagem: [sx,sy] de cada nó novo }.
   */
  function espelhar(malha, planos) {
    const nos = [], quads = [], origem = [], imagem = [], chave = new Map();
    planos.forEach(([sx, sy]) => {
      const id = new Map();
      const no = i => {
        if (id.has(i)) return id.get(i);
        const q = malha.nos[i], x = sx * q[0], y = sy * q[1];
        const k = x.toFixed(6) + ',' + y.toFixed(6) + ',' + q[2].toFixed(6) + '|' + sx + sy;
        let j = chave.get(k);
        if (j == null) { j = nos.length; nos.push([x, y, q[2]]); origem.push(i); imagem.push([sx, sy]); chave.set(k, j); }
        id.set(i, j); return j;
      };
      malha.quads.forEach(f => { const g = f.map(no); quads.push(sx * sy < 0 ? g.slice().reverse() : g); });
    });
    return { nos, quads, origem, imagem };
  }
  /**
   * Gira um perfil axissimétrico (r, z) em torno do eixo z.
   * perfil: { nos: [[r, ?, z]], segs: [[a,b]] }; n: divisões na volta.
   * Devolve { nos, quads, origem, ang } (origem = nó do perfil, ang = ângulo do nó novo).
   */
  function revolver(perfil, n) {
    n = n || 48;
    const nos = [], origem = [], ang = [], id = new Map();
    const no = (i, k) => {
      const kk = i + ':' + (k % n); if (id.has(kk)) return id.get(kk);
      const r = perfil.nos[i][0], z = perfil.nos[i][2], t = (k % n) / n * 2 * Math.PI;
      const j = nos.length; nos.push([r * Math.cos(t), r * Math.sin(t), z]); origem.push(i); ang.push(t); id.set(kk, j); return j;
    };
    const quads = [];
    perfil.segs.forEach(([a, b]) => { for (let k = 0; k < n; k++) quads.push([no(a, k), no(b, k), no(b, k + 1), no(a, k + 1)]); });
    return { nos, quads, origem, ang };
  }

  /* ---------------- visualizador ---------------- */
  /**
   * Cria um visualizador dentro de `alvo` (elemento com altura definida).
   * opts: { fundo: CSS (padrão --bg), fov: 38 }
   */
  function criar(alvo, opts) {
    opts = opts || {};
    const T = global.THREE;
    if (!T || !T.OrbitControls) throw new Error('Chame Motor3D.carregar() antes de criar o visualizador.');
    let R;
    try { R = new T.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true }); }
    catch (e) { throw new Error('WebGL indisponível neste navegador.'); }
    estiloLegendas();
    R.setPixelRatio(Math.min(2, global.devicePixelRatio || 1));
    R.localClippingEnabled = true;
    alvo.appendChild(R.domElement);
    R.domElement.style.display = 'block'; R.domElement.style.width = '100%'; R.domElement.style.height = '100%';
    const cena = new T.Scene();
    const cam = new T.PerspectiveCamera(opts.fov || 38, 1, 0.01, 2000);
    const ctl = new T.OrbitControls(cam, R.domElement);
    ctl.enableDamping = false; ctl.screenSpacePanning = true;
    cena.add(new T.HemisphereLight(0xffffff, 0x9aa4b0, 0.62));
    const l1 = new T.DirectionalLight(0xffffff, 0.42); l1.position.set(6, 12, 8); cena.add(l1);
    const l2 = new T.DirectionalLight(0xffffff, 0.18); l2.position.set(-8, 4, -6); cena.add(l2);
    let grupo = new T.Group(); cena.add(grupo);
    let planos = [];                      // planos de corte ativos (three.Plane)
    const pegaveis = [];                  // malhas com valores por nó (para a leitura no clique)
    let aoClicarFn = null, marca = null, pend = false;

    const render = () => { pend = false; cena.background = new T.Color(hex(rgb(opts.fundo || '--bg', [244, 246, 248]))); R.render(cena, cam); };
    const pedir = () => { if (!pend) { pend = true; requestAnimationFrame(render); } };
    ctl.addEventListener('change', pedir);
    const tam = () => {
      const w = alvo.clientWidth, h = alvo.clientHeight; if (!w || !h) return;
      R.setSize(w, h, false); cam.aspect = w / h; cam.updateProjectionMatrix(); pedir();
    };
    let ro = null; try { ro = new ResizeObserver(tam); ro.observe(alvo); } catch (e) { global.addEventListener('resize', tam); }
    tam();

    const matOpts = o => Object.assign({ side: T.DoubleSide, clippingPlanes: planos }, o);

    // textura 1D da escala arco-íris: faixas nítidas (NearestFilter) ou contínua (LinearFilter)
    function texturaDe(esc) {
      if (esc._tex) return esc._tex;
      const w = esc.faixas || 256, data = new Uint8Array(4 * w);
      for (let i = 0; i < w; i++) { const c = esc.faixas ? esc.corFaixa(i) : esc.rampa((i + 0.5) / w); data[4 * i] = c[0]; data[4 * i + 1] = c[1]; data[4 * i + 2] = c[2]; data[4 * i + 3] = 255; }
      const t = new T.DataTexture(data, w, 1, T.RGBAFormat);
      t.magFilter = t.minFilter = esc.faixas ? T.NearestFilter : T.LinearFilter; t.generateMipmaps = false; t.needsUpdate = true;
      esc._tex = t; return t;
    }

    function limpar() {
      grupo.traverse(o => { if (o.geometry) o.geometry.dispose(); if (o.material) [].concat(o.material).forEach(m => m.dispose()); });
      cena.remove(grupo); grupo = new T.Group(); cena.add(grupo); pegaveis.length = 0; marca = null; pedir();
    }

    /**
     * Superfície de casca.
     * s: { nos:[[x,y,z]], quads:[[a,b,c,d]] | tris:[[a,b,c]], valores?:[...por nó], escala?: Motor3D.escala(...),
     *      cor?: CSS (cor única quando não há valores), opacidade?: 0..1, arestas?: bool (contorno dos elementos),
     *      desloc?: [[dx,dy,dz]] por nó, fator?: multiplicador da deformada, info?: qualquer dado devolvido no clique }
     */
    function superficie(s) {
      const n = s.nos.length, pos = new Float32Array(3 * n);
      const tex = s.valores && s.escala && s.escala.tipo === 'arco-iris' ? texturaDe(s.escala) : null;
      const col = s.valores && !tex ? new Float32Array(3 * n) : null, uv = tex ? new Float32Array(2 * n) : null;
      const f = s.fator || 0;
      for (let i = 0; i < n; i++) {
        const q = s.nos[i], d = s.desloc && f ? s.desloc[i] : null;
        const p = P3(q[0] + (d ? f * d[0] : 0), q[1] + (d ? f * d[1] : 0), q[2] + (d ? f * d[2] : 0));
        pos[3 * i] = p[0]; pos[3 * i + 1] = p[1]; pos[3 * i + 2] = p[2];
        if (col) { const c = s.escala.cor(s.valores[i]); col[3 * i] = c[0] / 255; col[3 * i + 1] = c[1] / 255; col[3 * i + 2] = c[2] / 255; }
        if (uv) { uv[2 * i] = Math.min(0.9999, Math.max(0.0001, s.escala.t(s.valores[i]))); uv[2 * i + 1] = 0.5; }
      }
      const idx = [];
      (s.quads || []).forEach(([a, b, c, d]) => { idx.push(a, b, c, a, c, d); });
      (s.tris || []).forEach(([a, b, c]) => { idx.push(a, b, c); });
      const g = new T.BufferGeometry();
      g.setAttribute('position', new T.BufferAttribute(pos, 3));
      if (col) g.setAttribute('color', new T.BufferAttribute(col, 3));
      if (uv) g.setAttribute('uv', new T.BufferAttribute(uv, 2));
      g.setIndex(idx); g.computeVertexNormals();
      const transp = s.opacidade != null && s.opacidade < 1;
      const m = new T.MeshLambertMaterial(matOpts({
        color: col || tex ? 0xffffff : new T.Color(hex(rgb(s.cor || '--concrete', [207, 214, 220]))), vertexColors: !!col, map: tex || null,
        transparent: transp, opacity: transp ? s.opacidade : 1, depthWrite: !transp,
        polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1
      }));
      const malha = new T.Mesh(g, m);
      malha.userData = { valores: s.valores || null, info: s.info, idx };
      grupo.add(malha);
      if (s.valores) pegaveis.push(malha);
      if (s.arestas) {
        const seg = [], lin = s.arestas === true ? s.quads || [] : s.arestas;
        lin.forEach(q => { for (let k = 0; k < q.length; k++) { const a = q[k], b = q[(k + 1) % q.length]; seg.push(a, b); } });
        const gl = new T.BufferGeometry(); gl.setAttribute('position', new T.BufferAttribute(pos, 3)); gl.setIndex(seg);
        grupo.add(new T.LineSegments(gl, new T.LineBasicMaterial({ color: new T.Color(hex(rgb(s.corArestas || '--muted', [94, 107, 120]))), transparent: true, opacity: s.opacArestas != null ? s.opacArestas : 0.18, clippingPlanes: planos })));
      }
      pedir();
      return malha;
    }

    /**
     * Sólido vertical entre as cotas z0 e z1, com contorno em planta retangular (l × c, centrado) ou circular (diâmetro l)
     * e furos [[l, c, circ], ...]. o: { cor, opacidade, arestas: bool, x0, y0 (centro) }
     */
    function solido(l, c, circ, furos, z0, z1, o) {
      o = o || {};
      if (!(z1 > z0 + 1e-9) || !(l > 0)) return null;
      const forma = (w, h, ci, path) => {
        const s = path ? new T.Path() : new T.Shape();
        if (ci) s.absarc(0, 0, w / 2, 0, 2 * Math.PI, false);
        else { s.moveTo(-w / 2, -h / 2); s.lineTo(w / 2, -h / 2); s.lineTo(w / 2, h / 2); s.lineTo(-w / 2, h / 2); s.lineTo(-w / 2, -h / 2); }
        return s;
      };
      const sh = forma(l, c, circ);
      (furos || []).forEach(([a, b, ci]) => { if (a > 0 && (ci || b > 0)) sh.holes.push(forma(a, b, ci, true)); });
      const g = new T.ExtrudeGeometry(sh, { depth: z1 - z0, bevelEnabled: false, curveSegments: 64 });
      g.rotateX(-Math.PI / 2); g.translate(o.x0 || 0, z0, -(o.y0 || 0));
      const transp = o.opacidade != null && o.opacidade < 1;
      const m = new T.Mesh(g, new T.MeshLambertMaterial(matOpts({ color: new T.Color(hex(rgb(o.cor || '--concrete', [207, 214, 220]))), transparent: transp, opacity: transp ? o.opacidade : 1, depthWrite: !transp })));
      grupo.add(m);
      if (o.arestas !== false) grupo.add(new T.LineSegments(new T.EdgesGeometry(g, 25), new T.LineBasicMaterial({ color: new T.Color(hex(rgb(o.corArestas || '--concrete-line', [107, 120, 132]))), transparent: transp, opacity: transp ? 0.5 : 1, clippingPlanes: planos })));
      pedir();
      return m;
    }
    /** Seta de origem [x,y,z], direção [dx,dy,dz] (não precisa ser unitária) e comprimento. */
    function seta(origem, dir, comp, cor) {
      if (!(comp > 1e-6)) return null;
      const o = P3(...origem), d = P3(...dir), v = new T.Vector3(...d).normalize();
      const hl = Math.min(comp * 0.4, 0.2), hw = hl * 0.65;
      const a = new T.ArrowHelper(v, new T.Vector3(...o), comp, new T.Color(hex(rgb(cor || '--ink'))).getHex(), hl, hw);
      a.traverse(x => { if (x.material) x.material.clippingPlanes = planos; });
      grupo.add(a); pedir(); return a;
    }
    /** Linha poligonal [[x,y,z], ...]. fechada: bool. */
    function linha(pts, cor, fechada, opac) {
      const g = new T.BufferGeometry().setFromPoints(pts.map(p => new T.Vector3(...P3(...p))));
      const M = new T.LineBasicMaterial({ color: new T.Color(hex(rgb(cor || '--ink'))), transparent: opac != null && opac < 1, opacity: opac == null ? 1 : opac, clippingPlanes: planos });
      const l = fechada ? new T.LineLoop(g, M) : new T.Line(g, M); grupo.add(l); pedir(); return l;
    }
    /** Marca um ponto (esfera pequena) — usado para máximo e mínimo. */
    function ponto(p, cor, raio) {
      const m = new T.Mesh(new T.SphereGeometry(raio || 0.04, 16, 12), new T.MeshBasicMaterial({ color: new T.Color(hex(rgb(cor || '--ink'))), depthTest: false }));
      m.position.set(...P3(...p)); m.renderOrder = 10; grupo.add(m); pedir(); return m;
    }

    /**
     * Corte: ativo = true mostra só o lado do plano. plano = { normal: [nx,ny,nz], d } em coordenadas de engenharia,
     * mantendo os pontos com n·p + d ≥ 0. Padrão: corte ao meio, guardando y ≥ 0 (a metade de trás; a câmera padrão olha da frente).
     */
    function corte(ativo, plano) {
      planos.length = 0;
      if (ativo) { const pl = plano || { normal: [0, 1, 0], d: 0 }; const n = P3(...pl.normal); planos.push(new T.Plane(new T.Vector3(...n), pl.d || 0)); }
      grupo.traverse(o => { if (o.material) [].concat(o.material).forEach(m => { m.clippingPlanes = planos; m.needsUpdate = true; }); });
      pedir();
    }
    /** Enquadra o conteúdo (ou uma caixa {min:[x,y,z], max:[x,y,z]}). dir: direção da câmera [x,y,z]. */
    function ajustar(caixa, dir) {
      let box;
      if (caixa) box = new T.Box3(new T.Vector3(...P3(caixa.min[0], caixa.max[1], caixa.min[2])), new T.Vector3(...P3(caixa.max[0], caixa.min[1], caixa.max[2])));
      else { box = new T.Box3().setFromObject(grupo); if (box.isEmpty()) return; }
      const c = box.getCenter(new T.Vector3()), s = box.getSize(new T.Vector3());
      const r = 0.5 * Math.max(s.x, s.y, s.z) * 1.15, dist = r / Math.sin(cam.fov * Math.PI / 360) * (cam.aspect < 1 ? 1.35 : 1);
      const d = new T.Vector3(...P3(...(dir || [0.62, -0.78, 0.5]))).normalize();
      ctl.target.copy(c); cam.position.copy(c.clone().add(d.multiplyScalar(dist)));
      cam.near = dist / 100; cam.far = dist * 100; cam.updateProjectionMatrix(); ctl.update(); pedir();
    }
    function zoom(f) { const t = ctl.target; cam.position.sub(t).multiplyScalar(f).add(t); ctl.update(); pedir(); }

    /**
     * Leitura no clique: fn({ ponto: [x,y,z], valor, no, info }) ou fn(null) quando o clique não acerta nada.
     * O valor é interpolado nos nós do triângulo atingido.
     */
    function aoClicar(fn) { aoClicarFn = fn; }
    let down = null;
    R.domElement.addEventListener('pointerdown', e => { down = [e.clientX, e.clientY]; });
    R.domElement.addEventListener('pointerup', e => {
      if (!aoClicarFn || !down || Math.hypot(e.clientX - down[0], e.clientY - down[1]) > 4 || e.button !== 0) return;
      const r = R.domElement.getBoundingClientRect();
      const ray = new T.Raycaster(); ray.setFromCamera(new T.Vector2((e.clientX - r.left) / r.width * 2 - 1, -(e.clientY - r.top) / r.height * 2 + 1), cam);
      let hits = ray.intersectObjects(pegaveis, false);
      if (planos.length) hits = hits.filter(h => planos.every(pl => pl.distanceToPoint(h.point) >= -1e-6));
      if (marca) { grupo.remove(marca); marca.geometry.dispose(); marca.material.dispose(); marca = null; }
      if (!hits.length) { aoClicarFn(null); pedir(); return; }
      const h = hits[0], ud = h.object.userData, pa = h.object.geometry.attributes.position, f = h.face;
      const A = new T.Vector3().fromBufferAttribute(pa, f.a), B = new T.Vector3().fromBufferAttribute(pa, f.b), C = new T.Vector3().fromBufferAttribute(pa, f.c);
      const bc = new T.Vector3(); T.Triangle.getBarycoord(h.point, A, B, C, bc);
      const v = ud.valores, val = bc.x * v[f.a] + bc.y * v[f.b] + bc.z * v[f.c];
      const no = [f.a, f.b, f.c][[bc.x, bc.y, bc.z].indexOf(Math.max(bc.x, bc.y, bc.z))];
      const span = h.distance * 0.012;
      marca = new T.Mesh(new T.SphereGeometry(span, 14, 10), new T.MeshBasicMaterial({ color: new T.Color(hex(rgb('--ink'))), depthTest: false }));
      marca.position.copy(h.point); marca.renderOrder = 11; grupo.add(marca);
      aoClicarFn({ ponto: [h.point.x, -h.point.z, h.point.y], valor: val, no, info: ud.info });
      pedir();
    });

    function destruir() { limpar(); if (ro) ro.disconnect(); ctl.dispose(); R.dispose(); R.domElement.remove(); }
    return { limpar, superficie, solido, seta, linha, ponto, corte, ajustar, zoom, aoClicar, render: pedir, tamanho: tam, destruir,
      get grupo() { return grupo; }, three: { cena, camera: cam, controles: ctl, renderer: R } };
  }

  global.Motor3D = { VERSAO, carregar, criar, escala, legendaHTML, espelhar, revolver, rgb, hex, ARCO, ARCO_CLARO };
})(typeof window !== 'undefined' ? window : globalThis);
