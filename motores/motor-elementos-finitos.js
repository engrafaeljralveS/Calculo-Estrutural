/*!
 * Motor de Elementos Finitos de casca — caixas de concreto armado
 * Conjunto "Cálculo Estrutural" · versão 1.0 · nov/2026 · extraído do programa Flutuação em Caixas v4
 *
 * Funções puras, sem DOM: roda na página ou dentro de um Web Worker (a própria função FEengine pode ser
 * transformada em texto com FEengine.toString() e enviada a um Worker, como o Flutuação em Caixas faz).
 *
 * Modelos:
 *   - caixa retangular: superfície média de lajes e paredes em 1/4 (simetria em x = 0 e y = 0); elemento de
 *     4 nós com 6 graus de liberdade por nó (membrana Q4 com modos incompatíveis + placa MITC4 de Mindlin +
 *     rigidez fictícia de giro no plano); molas de Winkler só de compressão sob a laje de fundo e a aba;
 *   - caixa circular (geo.circ = true): casca axissimétrica (parede cilíndrica + lajes como placas circulares).
 * Eixos: x ao longo de B, y ao longo de L, z vertical (z = 0 no eixo da laje de fundo). Unidades: kN e m.
 *
 * Uso:
 *   const FE = FEengine();
 *   const r = FE.analyze(inp);            // inp descrito em motores/LEIAME.md
 *   r.nodes        [[x,y,z]]              nós (no modelo circular: [r, 0, z])
 *   r.elems        [{ s, n:[...] }]       s = 'top' | 'bot' | 'wx' | 'wy' (superfície); n = nós do elemento
 *   r.surfNodes    { s: [nós] }           nós de cada superfície, na ordem das resultantes
 *   r.results[k]   por combinação:
 *       res[s]     Float64Array 8 por nó: [M1, M2, M12, Q1, Q2, N1, N2, N12] nos eixos locais da superfície
 *                  (M > 0 traciona a face externa; N > 0 tração)
 *       disp       Float64Array 3 por nó (m): deslocamentos x, y, z
 *       press      Float64Array por nó (kPa): pressão de contato nas molas
 *       R, Fz      reação total e carga vertical aplicada (kN, caixa inteira) · lifted, floated
 *   r.stats        { nElem, nNode, nEq, ms }
 *
 * A montagem da entrada (cargas por componente e combinações) e o pós-processamento (envoltórias,
 * Wood-Armer, dimensionamento) ficam no programa: veja Arm.feInput, Arm.merge e Arm.post em apps/flutuacao.html.
 */
function FEengine() {
  const G2 = [-1 / Math.sqrt(3), 1 / Math.sqrt(3)];
  const NODE = [[-1, -1], [1, -1], [1, 1], [-1, 1]];

  // Superfícies: eixos locais (linhas de T = eixos locais em coordenadas globais). z' aponta para fora da caixa.
  const SURF = {
    top: { T: [[1, 0, 0], [0, 1, 0], [0, 0, 1]] },      // x' = x (B), y' = y (L)
    bot: { T: [[0, 1, 0], [1, 0, 0], [0, 0, -1]] },     // x' = y (L), y' = x (B)
    wx: { T: [[0, 1, 0], [0, 0, 1], [1, 0, 0]] },      // parede em x = Bc/2: x' = y (horizontal), y' = z (vertical)
    wy: { T: [[0, 0, 1], [1, 0, 0], [0, 1, 0]] }       // parede em y = Lc/2: x' = z (vertical), y' = x (horizontal)
  };

  /* ----- matriz do elemento retangular (cache por dimensões) ----- */
  const cache = new Map();
  function elemMats(a, b, t, E, nu) {
    const key = [a.toFixed(6), b.toFixed(6), t.toFixed(5), E, nu].join('|');
    if (cache.has(key)) return cache.get(key);
    const ha = a / 2, hb = b / 2, dJ = ha * hb;
    const Am = E * t / (1 - nu * nu), Db = E * t * t * t / (12 * (1 - nu * nu)), Ds = 5 / 6 * E / (2 * (1 + nu)) * t;
    const C = [[1, nu, 0], [nu, 1, 0], [0, 0, (1 - nu) / 2]];
    const N = (i, x, y) => 0.25 * (1 + NODE[i][0] * x) * (1 + NODE[i][1] * y);
    const Nx = (i, x, y) => 0.25 * NODE[i][0] * (1 + NODE[i][1] * y) / ha;
    const Ny = (i, x, y) => 0.25 * NODE[i][1] * (1 + NODE[i][0] * x) / hb;
    const zeros = (r, c) => Array.from({ length: r }, () => new Float64Array(c));
    const K = zeros(24, 24);
    // ---- membrana: nós (u,v) -> 8 gl; modos incompatíveis 4 gl
    const Kcc = zeros(8, 8), Kci = zeros(8, 4), Kii = zeros(4, 4);
    const BmAt = (x, y) => {
      const Bc = zeros(3, 8), Bi = zeros(3, 4);
      for (let i = 0; i < 4; i++) { const dx = Nx(i, x, y), dy = Ny(i, x, y); Bc[0][2 * i] = dx; Bc[1][2 * i + 1] = dy; Bc[2][2 * i] = dy; Bc[2][2 * i + 1] = dx; }
      Bi[0][0] = -2 * x / ha; Bi[1][3] = -2 * y / hb; Bi[2][1] = -2 * y / hb; Bi[2][2] = -2 * x / ha;
      return { Bc, Bi };
    };
    const addBtDB = (Kout, B1, B2, D, f) => {
      const r1 = B1[0].length, r2 = B2[0].length;
      for (let p = 0; p < r1; p++) for (let q = 0; q < r2; q++) {
        let s = 0;
        for (let i = 0; i < 3; i++) { if (!B1[i][p]) continue; for (let j = 0; j < 3; j++) s += B1[i][p] * D[i][j] * B2[j][q]; }
        Kout[p][q] += s * f;
      }
    };
    const Dm = C.map(r => r.map(v => v * Am)), Dbm = C.map(r => r.map(v => v * Db));
    G2.forEach(x => G2.forEach(y => {
      const { Bc, Bi } = BmAt(x, y);
      addBtDB(Kcc, Bc, Bc, Dm, dJ); addBtDB(Kci, Bc, Bi, Dm, dJ); addBtDB(Kii, Bi, Bi, Dm, dJ);
    }));
    // condensação estática: K = Kcc − Kci Kii⁻¹ Kic ;  R = Kii⁻¹ Kic (para recuperar os modos internos)
    const inv = invert(Kii.map(r => Array.from(r)));
    const R = zeros(4, 8);
    for (let i = 0; i < 4; i++) for (let j = 0; j < 8; j++) { let s = 0; for (let k = 0; k < 4; k++) s += inv[i][k] * Kci[j][k]; R[i][j] = s; }
    const mDof = i => [6 * i, 6 * i + 1];
    for (let p = 0; p < 8; p++) for (let q = 0; q < 8; q++) {
      let s = Kcc[p][q]; for (let k = 0; k < 4; k++) s -= Kci[p][k] * R[k][q];
      K[mDof(p >> 1)[p & 1]][mDof(q >> 1)[q & 1]] += s;
    }
    // ---- placa MITC4: gl locais (w, φx, φy); φx = θy', φy = −θx'
    const bDof = i => [6 * i + 2, 6 * i + 3, 6 * i + 4];
    // B de flexão: κx = Σ Nx φx ; κy = Σ Ny φy ; κxy = Σ (Ny φx + Nx φy)   (colunas: w, φx, φy por nó)
    const BbAt = (x, y) => { const B = zeros(3, 12); for (let i = 0; i < 4; i++) { const dx = Nx(i, x, y), dy = Ny(i, x, y); B[0][3 * i + 1] = dx; B[1][3 * i + 2] = dy; B[2][3 * i + 1] = dy; B[2][3 * i + 2] = dx; } return B; };
    // cisalhamento direto: γxz = ∂w/∂x + φx ; γyz = ∂w/∂y + φy
    const gxzAt = (x, y) => { const r = new Float64Array(12); for (let i = 0; i < 4; i++) { r[3 * i] = Nx(i, x, y); r[3 * i + 1] = N(i, x, y); } return r; };
    const gyzAt = (x, y) => { const r = new Float64Array(12); for (let i = 0; i < 4; i++) { r[3 * i] = Ny(i, x, y); r[3 * i + 2] = N(i, x, y); } return r; };
    const gA = gxzAt(0, -1), gC = gxzAt(0, 1), gD = gyzAt(-1, 0), gB = gyzAt(1, 0);
    const BsAt = (x, y) => { const B = zeros(2, 12); for (let k = 0; k < 12; k++) { B[0][k] = 0.5 * (1 - y) * gA[k] + 0.5 * (1 + y) * gC[k]; B[1][k] = 0.5 * (1 - x) * gD[k] + 0.5 * (1 + x) * gB[k]; } return B; };
    const Kp = zeros(12, 12);
    G2.forEach(x => G2.forEach(y => {
      const Bb = BbAt(x, y), Bs = BsAt(x, y);
      addBtDB(Kp, Bb, Bb, Dbm, dJ);
      for (let p = 0; p < 12; p++) for (let q = 0; q < 12; q++) Kp[p][q] += Ds * (Bs[0][p] * Bs[0][q] + Bs[1][p] * Bs[1][q]) * dJ;
    }));
    // (w, φx, φy) -> (w, θx', θy'):  φx = θy', φy = −θx'
    const map = (k) => { const n = Math.floor(k / 3), c = k % 3; return c === 0 ? [6 * n + 2, 1] : c === 1 ? [6 * n + 4, 1] : [6 * n + 3, -1]; };
    for (let p = 0; p < 12; p++) for (let q = 0; q < 12; q++) { const [ip, sp] = map(p), [iq, sq] = map(q); K[ip][iq] += sp * sq * Kp[p][q]; }
    // giro no plano (fictício)
    const kd = 1e-3 * Db;
    for (let i = 0; i < 4; i++) K[6 * i + 5][6 * i + 5] += kd;
    // ---- resultantes nos 4 pontos de Gauss, como funções lineares dos 24 gl locais
    // ordem: [M1, M2, M12, Q1, Q2, N1, N2, N12]
    const S = [];
    G2.forEach(y => G2.forEach(x => { /* preenchido abaixo na ordem dos nós */ }));
    const gp = [[G2[0], G2[0]], [G2[1], G2[0]], [G2[1], G2[1]], [G2[0], G2[1]]];
    gp.forEach(([x, y]) => {
      const rows = Array.from({ length: 8 }, () => new Float64Array(24));
      const Bb = BbAt(x, y), Bs = BsAt(x, y);
      for (let k = 0; k < 12; k++) {
        const [ik, sk] = map(k);
        for (let r = 0; r < 3; r++) { let s = 0; for (let j = 0; j < 3; j++) s += Dbm[r][j] * Bb[j][k]; rows[r][ik] += sk * s; }
        rows[3][ik] += sk * Ds * Bs[0][k]; rows[4][ik] += sk * Ds * Bs[1][k];
      }
      const { Bc, Bi } = BmAt(x, y);
      // ε = Bc uc + Bi a ,  a = −R uc
      const Beff = zeros(3, 8);
      for (let r = 0; r < 3; r++) for (let q = 0; q < 8; q++) { let s = Bc[r][q]; for (let k = 0; k < 4; k++) s -= Bi[r][k] * R[k][q]; Beff[r][q] = s; }
      for (let r = 0; r < 3; r++) for (let q = 0; q < 8; q++) { let s = 0; for (let j = 0; j < 3; j++) s += Dm[r][j] * Beff[j][q]; rows[5 + r][mDof(q >> 1)[q & 1]] += s; }
      S.push(rows);
    });
    // extrapolação Gauss -> nós
    const s3 = Math.sqrt(3), X = NODE.map(([xi, yi]) => gp.map(([xg, yg]) => 0.25 * (1 + xi * s3 * Math.sign(xg)) * (1 + yi * s3 * Math.sign(yg))));
    const out = { K, S, X, ha, hb, dJ, N, Db };
    cache.set(key, out);
    return out;
  }

  function invert(A) {
    const n = A.length, M = A.map((r, i) => r.concat(Array.from({ length: n }, (_, j) => (i === j ? 1 : 0))));
    for (let c = 0; c < n; c++) {
      let p = c; for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
      [M[c], M[p]] = [M[p], M[c]];
      const d = M[c][c]; for (let j = 0; j < 2 * n; j++) M[c][j] /= d;
      for (let r = 0; r < n; r++) if (r !== c) { const f = M[r][c]; if (f) for (let j = 0; j < 2 * n; j++) M[r][j] -= f * M[c][j]; }
    }
    return M.map(r => r.slice(n));
  }

  /* ----- malha ----- */
  // Divide [a,b] passando pelos pontos-chave, com passo ≤ h
  // zones: [[a, b, hf]] = faixas com passo menor (ligações parede-laje)
  function axis(keys, h, zones = []) {
    const lo = Math.min(...keys), hi = Math.max(...keys);
    zones.forEach(([a, b]) => { if (a > lo && a < hi) keys.push(a); if (b > lo && b < hi) keys.push(b); });
    const k = [...new Set(keys.map(v => +v.toFixed(6)))].sort((a, b) => a - b);
    const out = [k[0]];
    for (let i = 1; i < k.length; i++) {
      const L = k[i] - k[i - 1]; if (L < 1e-6) continue;
      const mid = (k[i] + k[i - 1]) / 2, z = zones.find(([a, b]) => mid > a && mid < b), hs = z ? Math.min(h, z[2]) : h;
      const n = Math.max(1, Math.round(L / hs)); for (let j = 1; j <= n; j++) out.push(k[i - 1] + L * j / n);
    }
    return out;
  }
  function buildBox(g) {
    const { Bc, Lc, Hc, ep, es, ei, ba, h } = g;
    const xw = Bc / 2, yw = Lc / 2, xf = xw - ep / 2, yf = yw - ep / 2, xo = xw + ep / 2, yo = yw + ep / 2;
    const bo = Math.min(g.bo || 0, 2 * xf), lo = Math.min(g.lo || 0, 2 * yf), opening = bo > 0 && lo > 0;
    const chim = opening && g.chimH > 0;
    const xk = [0, xf, xw], yk = [0, yf, yw];
    if (opening) { xk.push(bo / 2); yk.push(lo / 2); if (chim) { xk.push(Math.min(bo / 2 + ep, xf)); yk.push(Math.min(lo / 2 + ep, yf)); } }
    // refino junto às ligações: do eixo até uma espessura além da face, passo ≤ t/4
    const hj = t => Math.max(0.02, t / 4);
    const zx = [[xf - ep / 2, xo + ep / 2, hj(ep)]], zy = [[yf - ep / 2, yo + ep / 2, hj(ep)]];
    const zz = [[0, ei, hj(ei)], [Hc - es, Hc, hj(es)]];
    const xs = axis(xk, h, zx), ys = axis(yk, h, zy);
    const xsb = axis(xk.concat(ba > 0 ? [xo, xo + ba] : []), h, zx), ysb = axis(yk.concat(ba > 0 ? [yo, yo + ba] : []), h, zy);
    const zk = [0, ei / 2, Hc - es / 2, Hc].concat(g.zExtra || []).filter(v => v >= 0 && v <= Hc);
    const zs = axis(zk, h, zz);
    const nodes = [], keyMap = new Map(), elems = [];
    const node = (x, y, z) => { const k = x.toFixed(5) + ',' + y.toFixed(5) + ',' + z.toFixed(5); let id = keyMap.get(k); if (id == null) { id = nodes.length; nodes.push([x, y, z]); keyMap.set(k, id); } return id; };
    // superfície: grade (u, v) -> ponto global; ordem dos nós anti-horária em torno de z'
    const surf = (name, us, vs, P, t, keep) => {
      for (let i = 0; i < us.length - 1; i++) for (let j = 0; j < vs.length - 1; j++) {
        const uc = (us[i] + us[i + 1]) / 2, vc = (vs[j] + vs[j + 1]) / 2;
        if (keep && !keep(uc, vc)) continue;
        const n = [node(...P(us[i], vs[j])), node(...P(us[i + 1], vs[j])), node(...P(us[i + 1], vs[j + 1])), node(...P(us[i], vs[j + 1]))];
        elems.push({ s: name, n, a: us[i + 1] - us[i], b: vs[j + 1] - vs[j], t, c: P(uc, vc), Ef: (g.noTop && name === 'top') ? 1e-4 : 1 });
      }
    };
    // laje de topo: x' = x, y' = y
    surf('top', xs, ys, (u, v) => [u, v, Hc], es, (u, v) => !(opening && u < bo / 2 && v < lo / 2));
    // laje de fundo: x' = y, y' = x  (u = y, v = x)
    surf('bot', ysb, xsb, (u, v) => [v, u, 0], ei);
    // parede em x = xw: x' = y, y' = z
    surf('wx', ys, zs, (u, v) => [xw, u, v], ep);
    // parede em y = yw: x' = z, y' = x
    surf('wy', zs, xs, (u, v) => [v, yw, u], ep);
    return { nodes, elems, xs, ys, xsb, ysb, zs, geo: { xw, yw, xf, yf, xo, yo, bo, lo, opening, chim, Hc, ep, es, ei, ba } };
  }

  /* ----- numeração (Cuthill-McKee reverso) e solver skyline LDLᵀ ----- */
  function rcm(nn, elems) {
    const adj = Array.from({ length: nn }, () => new Set());
    elems.forEach(e => e.n.forEach(a => e.n.forEach(b => { if (a !== b) adj[a].add(b); })));
    const deg = adj.map(s => s.size), seen = new Uint8Array(nn), order = [];
    const bfs = start => { const lv = new Int32Array(nn).fill(-1); lv[start] = 0; const q = [start]; for (let i = 0; i < q.length; i++) adj[q[i]].forEach(v => { if (lv[v] < 0) { lv[v] = lv[q[i]] + 1; q.push(v); } }); return { q, lv }; };
    for (let s0 = 0; s0 < nn; s0++) {
      if (seen[s0]) continue;
      let start = s0;
      for (let it = 0; it < 3; it++) { const { q, lv } = bfs(start); const far = q[q.length - 1]; let best = far; q.forEach(v => { if (lv[v] === lv[far] && deg[v] < deg[best]) best = v; }); start = best; }
      const q = [start]; seen[start] = 1;
      for (let i = 0; i < q.length; i++) {
        const nb = [...adj[q[i]]].filter(v => !seen[v]).sort((a, b) => deg[a] - deg[b]);
        nb.forEach(v => { seen[v] = 1; q.push(v); });
      }
      order.push(...q);
    }
    return order.reverse();
  }

  function factor(a, maxa, n) {
    for (let N = 0; N < n; N++) {
      const kn = maxa[N], kl = kn + 1, ku = maxa[N + 1] - 1, kh = ku - kl;
      if (kh > 0) {
        let k = N - kh, ic = 0, klt = ku;
        for (let j = 1; j <= kh; j++) {
          ic++; klt--;
          const ki = maxa[k], nd = maxa[k + 1] - ki - 1;
          if (nd > 0) { const kk = Math.min(ic, nd); let c = 0; for (let l = 1; l <= kk; l++) c += a[ki + l] * a[klt + l]; a[klt] -= c; }
          k++;
        }
      }
      if (kh >= 0) {
        let k = N, b = 0;
        for (let kk = kl; kk <= ku; kk++) { k--; const ki = maxa[k], c = a[kk] / a[ki]; b += c * a[kk]; a[kk] = c; }
        a[kn] -= b;
      }
      if (!(a[kn] > 0)) return false;
    }
    return true;
  }
  function backsub(a, maxa, n, v) {
    for (let N = 0; N < n; N++) { const kl = maxa[N] + 1, ku = maxa[N + 1] - 1; if (ku >= kl) { let k = N, c = 0; for (let kk = kl; kk <= ku; kk++) { k--; c += a[kk] * v[k]; } v[N] -= c; } }
    for (let N = 0; N < n; N++) v[N] /= a[maxa[N]];
    for (let N = n - 1; N > 0; N--) { const kl = maxa[N] + 1, ku = maxa[N + 1] - 1; if (ku >= kl) { let k = N; for (let kk = kl; kk <= ku; kk++) { k--; v[k] -= a[kk] * v[N]; } } }
    return v;
  }

  /* ----- montagem ----- */
  function prepare(mesh, mat, fixedDof) {
    const nn = mesh.nodes.length, order = rcm(nn, mesh.elems);
    const eq = new Int32Array(6 * nn).fill(-1);
    let n = 0;
    order.forEach(nd => { for (let d = 0; d < 6; d++) if (!fixedDof(nd, d)) eq[6 * nd + d] = n++; });
    const top = new Int32Array(n); for (let i = 0; i < n; i++) top[i] = i;
    mesh.elems.forEach(e => {
      const eqs = []; e.n.forEach(nd => { for (let d = 0; d < 6; d++) { const q = eq[6 * nd + d]; if (q >= 0) eqs.push(q); } });
      const mn = Math.min(...eqs); eqs.forEach(q => { if (mn < top[q]) top[q] = mn; });
    });
    const maxa = new Int32Array(n + 1); for (let j = 0; j < n; j++) maxa[j + 1] = maxa[j] + (j - top[j] + 1);
    const a0 = new Float64Array(maxa[n]);
    mesh.elems.forEach(e => {
      const M = elemMats(e.a, e.b, e.t, mat.E * (e.Ef || 1), mat.nu), T = SURF[e.s].T;
      // Kg = Rᵀ K R, R = blocos de T
      const Kg = globalK(M.K, T);
      const idx = []; e.n.forEach(nd => { for (let d = 0; d < 6; d++) idx.push(eq[6 * nd + d]); });
      for (let p = 0; p < 24; p++) { const i = idx[p]; if (i < 0) continue; for (let q = 0; q < 24; q++) { const j = idx[q]; if (j < 0 || i > j) continue; a0[maxa[j] + (j - i)] += Kg[p][q]; } }
    });
    return { eq, n, maxa, a0, nnz: maxa[n] };
  }
  function globalK(K, T) {
    // R (24×24) bloco-diagonal com T 3×3; Kg = Rᵀ K R
    const Kg = Array.from({ length: 24 }, () => new Float64Array(24));
    const tmp = Array.from({ length: 24 }, () => new Float64Array(24));
    for (let p = 0; p < 24; p++) for (let q = 0; q < 24; q++) {        // tmp = K R
      const bq = q - q % 3; let s = 0; for (let k = 0; k < 3; k++) s += K[p][bq + k] * T[k][q % 3]; tmp[p][q] = s;
    }
    for (let p = 0; p < 24; p++) for (let q = 0; q < 24; q++) {        // Kg = Rᵀ tmp
      const bp = p - p % 3; let s = 0; for (let k = 0; k < 3; k++) s += T[k][p % 3] * tmp[bp + k][q]; Kg[p][q] = s;
    }
    return Kg;
  }
  // vetor de cargas global a partir de força por área f(x,y,z,e) -> [fx,fy,fz] (global)
  function areaLoad(mesh, eq, n, fn) {
    const F = new Float64Array(n);
    mesh.elems.forEach(e => {
      const M = elemMats(e.a, e.b, e.t, 1, 0.2);
      const P = e.n.map(i => mesh.nodes[i]);
      G2.forEach(x => G2.forEach(y => {
        const Nv = [0, 1, 2, 3].map(i => M.N(i, x, y));
        const X = [0, 1, 2].map(c => Nv.reduce((s, v, i) => s + v * P[i][c], 0));
        const f = fn(X[0], X[1], X[2], e); if (!f) return;
        for (let i = 0; i < 4; i++) for (let c = 0; c < 3; c++) { const q = eq[6 * e.n[i] + c]; if (q >= 0) F[q] += Nv[i] * f[c] * M.dJ; }
      }));
    });
    return F;
  }

  /* ----- resultantes: pontos de Gauss e recuperação nodal (SPR, Zienkiewicz-Zhu) ----- */
  function gaussValues(mesh, eq, U, mat) {
    return mesh.elems.map(e => {
      const M = elemMats(e.a, e.b, e.t, mat.E * (e.Ef || 1), mat.nu), T = SURF[e.s].T, ul = new Float64Array(24);
      e.n.forEach((nd, k) => { for (let blk = 0; blk < 2; blk++) { const gv = [0, 1, 2].map(c => { const q = eq[6 * nd + 3 * blk + c]; return q >= 0 ? U[q] : 0; }); for (let r = 0; r < 3; r++) ul[6 * k + 3 * blk + r] = T[r][0] * gv[0] + T[r][1] * gv[1] + T[r][2] * gv[2]; } });
      return M.S.map(rows => rows.map(row => { let s = 0; for (let k = 0; k < 24; k++) s += row[k] * ul[k]; return s; }));
    });
  }
  // Para cada superfície: lista de nós e, para cada nó, pesos sobre os valores de Gauss (elemento, ponto)
  function recovery(mesh) {
    const surfNodes = {}, surfIdx = {}, W = {};
    const gpPos = mesh.elems.map(e => {
      const M = elemMats(e.a, e.b, e.t, 1, 0.2), T = SURF[e.s].T, P = e.n.map(i => mesh.nodes[i]);
      return [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([sx, sy]) => {
        const x = sx / Math.sqrt(3), y = sy / Math.sqrt(3), Nv = [0, 1, 2, 3].map(i => M.N(i, x, y));
        const X = [0, 1, 2].map(c => Nv.reduce((s, v, i) => s + v * P[i][c], 0));
        return [T[0][0] * X[0] + T[0][1] * X[1] + T[0][2] * X[2], T[1][0] * X[0] + T[1][1] * X[1] + T[1][2] * X[2]];
      });
    });
    const uv = (s, i) => { const T = SURF[s].T, X = mesh.nodes[i]; return [T[0][0] * X[0] + T[0][1] * X[1] + T[0][2] * X[2], T[1][0] * X[0] + T[1][1] * X[1] + T[1][2] * X[2]]; };
    ['top', 'bot', 'wx', 'wy'].forEach(s => {
      const nodeEl = new Map();
      mesh.elems.forEach((e, ei) => { if (e.s !== s) return; e.n.forEach((i, k) => { if (!nodeEl.has(i)) nodeEl.set(i, []); nodeEl.get(i).push([ei, k]); }); });
      const list = [...nodeEl.keys()]; surfNodes[s] = list; surfIdx[s] = new Map(list.map((i, j) => [i, j]));
      // polinômio do patch de cada nó interior (4 elementos): p = [1, u, v, uv] centrado no nó
      const patch = new Map();
      nodeEl.forEach((els, i) => {
        if (els.length !== 4) return;
        const [u0, v0] = uv(s, i), pts = [];
        els.forEach(([ei]) => gpPos[ei].forEach((q, g) => pts.push([ei, g, q[0] - u0, q[1] - v0])));
        const A = [[0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]];
        pts.forEach(([, , du, dv]) => { const p = [1, du, dv, du * dv]; for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++) A[r][c] += p[r] * p[c]; });
        patch.set(i, { u0, v0, Ai: invert(A), pts });
      });
      const evalPatch = (pt, u, v) => { const p = [1, u - pt.u0, v - pt.v0, (u - pt.u0) * (v - pt.v0)], c = [0, 1, 2, 3].map(r => pt.Ai[r].reduce((s2, x, k) => s2 + x * p[k], 0)); return pt.pts.map(([ei, g, du, dv]) => [ei, g, c[0] + c[1] * du + c[2] * dv + c[3] * du * dv]); };
      W[s] = list.map(i => {
        const [u, v] = uv(s, i);
        if (patch.has(i)) return evalPatch(patch.get(i), u, v);
        // nó de borda: média das extrapolações dos patches vizinhos
        const nb = new Set(); nodeEl.get(i).forEach(([ei]) => mesh.elems[ei].n.forEach(j => { if (patch.has(j)) nb.add(j); }));
        if (nb.size) { const acc = []; nb.forEach(j => evalPatch(patch.get(j), u, v).forEach(([ei, g, w]) => acc.push([ei, g, w / nb.size]))); return acc; }
        // sem patch interior: extrapolação dentro dos próprios elementos
        const els = nodeEl.get(i), acc = [];
        els.forEach(([ei, k]) => { const M = elemMats(mesh.elems[ei].a, mesh.elems[ei].b, mesh.elems[ei].t, 1, 0.2); for (let g = 0; g < 4; g++) acc.push([ei, g, M.X[k][g] / els.length]); });
        return acc;
      });
    });
    return { surfNodes, surfIdx, W };
  }
  function nodal(rec, gpv) {
    const out = {};
    Object.keys(rec.W).forEach(s => {
      const W = rec.W[s], a = new Float64Array(W.length * 8);
      W.forEach((ws, j) => ws.forEach(([ei, g, w]) => { const v = gpv[ei][g]; for (let r = 0; r < 8; r++) a[8 * j + r] += w * v[r]; }));
      out[s] = a;
    });
    return out;
  }

  /* ----- análise completa ----- */
  // inp: { geo, mat:{E,nu}, kv, loads:{...}, combos:[{f:[4], lin:bool}] }
  function analyze(inp) {
    if (inp.geo && inp.geo.circ) return analyzeAxi(inp);
    const t0 = Date.now();
    const L = inp.loads, g = inp.geo;
    const zi = L.hagW > 0 ? g.ei / 2 + L.hagW : -1;
    const mesh = buildBox(Object.assign({}, g, { zExtra: [L.dw > L.dA && L.dw < L.dB ? L.dB - L.dw : -1, zi].filter(v => v > 0) }));
    const G = mesh.geo, nn = mesh.nodes.length;
    const fixed = (nd, d) => { const [x, y] = mesh.nodes[nd]; return (Math.abs(x) < 1e-9 && (d === 0 || d === 4 || d === 5)) || (Math.abs(y) < 1e-9 && (d === 1 || d === 3 || d === 5)); };
    const sys = prepare(mesh, inp.mat, fixed);
    const { eq, n, maxa, a0 } = sys;
    // molas: área de influência dos nós da laje de fundo
    const trib = new Float64Array(nn);
    mesh.elems.forEach(e => { if (e.s === 'bot') e.n.forEach(i => { trib[i] += e.a * e.b / 4; }); });
    const springNodes = []; for (let i = 0; i < nn; i++) if (trib[i] > 0) springNodes.push(i);

    // ---- cargas (4 componentes): 0 permanentes verticais, 1 empuxo + água, 2 sobrecarga vertical, 3 sobrecarga lateral
    const dS = Math.max(0, L.dw);
    const sh = d => Math.max(0, L.K * (d <= dS ? L.gd * d : L.gd * dS + L.gp * (d - dS)) - L.cT);
    const uw = d => L.gw * Math.max(0, d - L.dw);
    const pg = d => sh(d) + uw(d);
    const depth = z => L.dB - z;
    const inAba = (x, y) => x > G.xo + 1e-9 || y > G.yo + 1e-9;
    const inRing = (x, y) => G.chim && x < G.bo / 2 + g.ep + 1e-9 && y < G.lo / 2 + g.ep + 1e-9;
    const F = [
      areaLoad(mesh, eq, n, (x, y, z, e) => {
        if (e.s === 'top') return [0, 0, -(L.qtSelf + (inRing(e.c[0], e.c[1]) ? L.qChim : L.qtSoil))];
        if (e.s === 'bot') return [0, 0, -L.qbSelf + (L.sepU ? 0 : L.uBase) - (inAba(e.c[0], e.c[1]) ? L.qAba : 0)];
        return [0, 0, -L.wallW];
      }),
      areaLoad(mesh, eq, n, (x, y, z, e) => e.s === 'wx' ? [-pg(depth(z)), 0, 0] : e.s === 'wy' ? [0, -pg(depth(z)), 0] : null),
      areaLoad(mesh, eq, n, (x, y, z, e) => e.s === 'top' ? [0, 0, -L.q] : (e.s === 'bot' && inAba(e.c[0], e.c[1])) ? [0, 0, -L.q] : null),
      areaLoad(mesh, eq, n, (x, y, z, e) => e.s === 'wx' ? [-L.Kq, 0, 0] : e.s === 'wy' ? [0, -L.Kq, 0] : null)
    ];
    // cargas de linha nas bordas: faixa da laje de topo além do eixo da parede (e_p/2) e pressão lateral
    // nas meias espessuras das lajes (do eixo até a face externa)
    const integ = (f, a, b) => { const m = 40, hh = (b - a) / m; let s = 0; for (let i = 0; i <= m; i++) s += f(a + i * hh) * ((i === 0 || i === m) ? 0.5 : 1); return s * hh; };
    const pTop = integ(pg, L.dA - g.es / 2, L.dA), pBot = integ(pg, L.dB, L.dB + g.ei / 2);
    const lineLoad = (Fv, pred, along, vec) => {
      // distribui carga por metro "vec" ao longo dos nós que satisfazem pred, pela coordenada "along"
      const ids = []; for (let i = 0; i < nn; i++) if (pred(mesh.nodes[i])) ids.push(i);
      ids.sort((a, b) => mesh.nodes[a][along] - mesh.nodes[b][along]);
      ids.forEach((id, k) => {
        const c = mesh.nodes[id][along], lo = k > 0 ? (c - mesh.nodes[ids[k - 1]][along]) / 2 : 0, hi = k < ids.length - 1 ? (mesh.nodes[ids[k + 1]][along] - c) / 2 : 0;
        for (let d = 0; d < 3; d++) { const q = eq[6 * id + d]; if (q >= 0 && vec[d]) Fv[q] += vec[d] * (lo + hi); }
      });
    };
    const near = (a, b) => Math.abs(a - b) < 1e-7;
    const topEdgeX = p => near(p[0], G.xw) && near(p[2], g.Hc), topEdgeY = p => near(p[1], G.yw) && near(p[2], g.Hc);
    const botEdgeX = p => near(p[0], G.xw) && near(p[2], 0) && p[1] <= G.yw + 1e-9, botEdgeY = p => near(p[1], G.yw) && near(p[2], 0) && p[0] <= G.xw + 1e-9;
    lineLoad(F[0], topEdgeX, 1, [0, 0, -(L.qtSelf + L.qtSoil) * g.ep / 2]);
    lineLoad(F[0], topEdgeY, 0, [0, 0, -(L.qtSelf + L.qtSoil) * g.ep / 2]);
    lineLoad(F[2], topEdgeX, 1, [0, 0, -L.q * g.ep / 2]);
    lineLoad(F[2], topEdgeY, 0, [0, 0, -L.q * g.ep / 2]);
    lineLoad(F[1], topEdgeX, 1, [-pTop, 0, 0]); lineLoad(F[1], topEdgeY, 0, [0, -pTop, 0]);
    lineLoad(F[1], botEdgeX, 1, [-pBot, 0, 0]); lineLoad(F[1], botEdgeY, 0, [0, -pBot, 0]);
    lineLoad(F[3], topEdgeX, 1, [-L.Kq * g.es / 2, 0, 0]); lineLoad(F[3], topEdgeY, 0, [0, -L.Kq * g.es / 2, 0]);
    lineLoad(F[3], botEdgeX, 1, [-L.Kq * g.ei / 2, 0, 0]); lineLoad(F[3], botEdgeY, 0, [0, -L.Kq * g.ei / 2, 0]);
    // carga vertical total aplicada (1/4 da caixa), por componente
    // 4: subpressão separada (etapa construtiva); 5: água interna (pressão nas paredes e na laje de fundo)
    F.push(L.sepU ? areaLoad(mesh, eq, n, (x, y, z, e) => e.s === 'bot' ? [0, 0, L.uBase - (inAba(e.c[0], e.c[1]) ? (L.qAbaW || 0) : 0)] : null) : new Float64Array(n));
    F.push(L.hagW > 0 ? areaLoad(mesh, eq, n, (x, y, z, e) => {
      if (e.s === 'wx' || e.s === 'wy') { if (!(z >= g.ei / 2 - 1e-9 && z < zi)) return null; const pi = L.gwI * (zi - z); return e.s === 'wx' ? [pi, 0, 0] : [0, pi, 0]; }
      if (e.s === 'bot' && e.c[0] < G.xf && e.c[1] < G.yf) return [0, 0, -L.gwI * L.hagW];
      return null;
    }) : new Float64Array(n));
    const Fz = F.map(Fv => { let s = 0; for (let i = 0; i < nn; i++) { const q = eq[6 * i + 2]; if (q >= 0) s += Fv[q]; } return s; });

    // ---- solução com molas (só compressão)
    const solveWith = (active, rhsList) => {
      const a = new Float64Array(a0);
      springNodes.forEach(i => { if (active[i]) { const q = eq[6 * i + 2]; if (q >= 0) a[maxa[q]] += inp.kv * trib[i]; } });
      if (!factor(a, maxa, n)) return null;
      return rhsList.map(r => backsub(a, maxa, n, Float64Array.from(r)));
    };
    const allOn = new Uint8Array(nn).fill(1);
    let nFact = 1;
    const base = solveWith(allOn, F);
    if (!base) return { error: 'A matriz de rigidez não é positiva definida. Confira a geometria e o coeficiente de mola.' };
    const uzOf = (U, i) => { const q = eq[6 * i + 2]; return q >= 0 ? U[q] : 0; };
    const solveCombo = cb => {
      let U = new Float64Array(n); cb.f.forEach((c, k) => { if (c && base[k]) for (let i = 0; i < n; i++) U[i] += c * base[k][i]; });
      let active = allOn, it = 0, lifted = 0;
      if (!cb.lin) {
        for (; it < 25; it++) {
          const next = new Uint8Array(nn); let changed = false, any = false;
          springNodes.forEach(i => { next[i] = uzOf(U, i) <= 0 ? 1 : 0; if (next[i]) any = true; if (next[i] !== active[i]) changed = true; });
          if (!changed) break;
          if (!any) return { U, active: next, floated: true, it };
          const Fc = new Float64Array(n); cb.f.forEach((c, k) => { if (c && F[k]) for (let i = 0; i < n; i++) Fc[i] += c * F[k][i]; });
          const r = solveWith(next, [Fc]); nFact++;
          if (!r) return { U, active: next, floated: true, it };
          U = r[0]; active = next;
        }
        springNodes.forEach(i => { if (!active[i]) lifted++; });
      }
      return { U, active, it, lifted, floated: false };
    };

    // ---- resultantes nodais por superfície (recuperação SPR)
    const rec = recovery(mesh), surfNodes = rec.surfNodes;
    const resultants = U => nodal(rec, gaussValues(mesh, eq, U, inp.mat));
    const disp = U => { const d = new Float64Array(nn * 3); for (let i = 0; i < nn; i++) for (let c = 0; c < 3; c++) { const q = eq[6 * i + c]; d[3 * i + c] = q >= 0 ? U[q] : 0; } return d; };

    const results = inp.combos.map(cb => {
      const r = solveCombo(cb);
      let R = 0; const press = new Float64Array(nn);
      springNodes.forEach(i => { if (r.active[i]) { const w = uzOf(r.U, i); press[i] = Math.max(0, -inp.kv * w); R += press[i] * trib[i]; } });
      const Fapp = cb.f.reduce((s, c, k) => s + (c && Fz[k] ? c * Fz[k] : 0), 0);
      return { res: resultants(r.U), disp: disp(r.U), press, R: 4 * R, Fz: -4 * Fapp, lifted: r.lifted, floated: r.floated, it: r.it };
    });
    return {
      nodes: mesh.nodes, elems: mesh.elems.map(e => ({ s: e.s, n: e.n, a: e.a, b: e.b, c: e.c })), geo: G, surfNodes, results,
      stats: { nElem: mesh.elems.length, nNode: nn, nEq: n, nnz: sys.nnz, nFact, ms: Date.now() - t0 }
    };
  }
  /* ===== Caixa circular: casca axissimétrica (parede cilíndrica + lajes como placas circulares) ===== */
  // Elemento de casca cônica de 2 nós (Grafton-Strome), 3 gl por nó: u_r (radial), u_z (vertical) e β
  // (giro no plano r-z, anti-horário). Deslocamento meridional linear e normal cúbico (Kirchhoff).
  // Forças nodais e rigidez para o anel completo (2π r). Unidades kN, m.
  const AXG = [[-0.861136311594053, 0.347854845137454], [-0.339981043584856, 0.652145154862546], [0.339981043584856, 0.652145154862546], [0.861136311594053, 0.347854845137454]];
  function axiGeom(P1, P2) {
    const dr = P2[0] - P1[0], dz = P2[1] - P1[1], L = Math.hypot(dr, dz);
    return { L, c: dr / L, s: dz / L };
  }
  function axiShape(xi, L) {
    const H = [1 - 3 * xi * xi + 2 * xi ** 3, L * (xi - 2 * xi * xi + xi ** 3), 3 * xi * xi - 2 * xi ** 3, L * (-xi * xi + xi ** 3)];
    const dH = [(-6 * xi + 6 * xi * xi) / L, 1 - 4 * xi + 3 * xi * xi, (6 * xi - 6 * xi * xi) / L, -2 * xi + 3 * xi * xi];
    const d2H = [(-6 + 12 * xi) / (L * L), (-4 + 6 * xi) / L, (6 - 12 * xi) / (L * L), (-2 + 6 * xi) / L];
    return { H, dH, d2H };
  }
  // linhas de deformação [ε_s, ε_θ, κ_s, κ_θ] em gl locais [u1, w1, β1, u2, w2, β2]
  function axiB(xi, r, g) {
    const { L, c, s } = g, S = axiShape(xi, L), H = S.H, dH = S.dH, d2H = S.d2H;
    return [
      [-1 / L, 0, 0, 1 / L, 0, 0],
      [c * (1 - xi) / r, -s * H[0] / r, -s * H[1] / r, c * xi / r, -s * H[2] / r, -s * H[3] / r],
      [0, -d2H[0], -d2H[1], 0, -d2H[2], -d2H[3]],
      [0, -c * dH[0] / r, -c * dH[1] / r, 0, -c * dH[2] / r, -c * dH[3] / r]
    ];
  }
  function axiT(g) {   // local = T · global, por nó: [u, w, β] = R [u_r, u_z, β]
    const T = Array.from({ length: 6 }, () => new Float64Array(6));
    for (let b = 0; b < 2; b++) { const o = 3 * b; T[o][o] = g.c; T[o][o + 1] = g.s; T[o + 1][o] = -g.s; T[o + 1][o + 1] = g.c; T[o + 2][o + 2] = 1; }
    return T;
  }
  function axiElemK(P1, P2, t, E, nu) {
    const g = axiGeom(P1, P2), Dm = E * t / (1 - nu * nu), Db = E * t ** 3 / (12 * (1 - nu * nu));
    const D = [[Dm, Dm * nu, 0, 0], [Dm * nu, Dm, 0, 0], [0, 0, Db, Db * nu], [0, 0, Db * nu, Db]];
    const kl = Array.from({ length: 6 }, () => new Float64Array(6));
    AXG.forEach(([x, w]) => {
      const xi = (1 + x) / 2, r = P1[0] + (P2[0] - P1[0]) * xi, B = axiB(xi, r, g), f = w / 2 * g.L * 2 * Math.PI * r;
      const DB = D.map(row => [0, 1, 2, 3, 4, 5].map(j => row[0] * B[0][j] + row[1] * B[1][j] + row[2] * B[2][j] + row[3] * B[3][j]));
      for (let i = 0; i < 6; i++) for (let j = 0; j < 6; j++) kl[i][j] += f * (B[0][i] * DB[0][j] + B[1][i] * DB[1][j] + B[2][i] * DB[2][j] + B[3][i] * DB[3][j]);
    });
    const T = axiT(g), kg = Array.from({ length: 6 }, () => new Float64Array(6));
    for (let i = 0; i < 6; i++) for (let j = 0; j < 6; j++) { let s = 0; for (let a = 0; a < 6; a++) { if (!T[a][i]) continue; for (let b = 0; b < 6; b++) if (T[b][j]) s += T[a][i] * kl[a][b] * T[b][j]; } kg[i][j] = s; }
    return { kl, kg, T, g, D };
  }
  // cargas de superfície q(r, z) → [q_r, q_z] (kN/m², global): vetor nodal local e global
  function axiElemF(P1, P2, fn) {
    const g = axiGeom(P1, P2), fl = new Float64Array(6);
    AXG.forEach(([x, w]) => {
      const xi = (1 + x) / 2, r = P1[0] + (P2[0] - P1[0]) * xi, z = P1[1] + (P2[1] - P1[1]) * xi, q = fn(r, z);
      if (!q) return;
      const qt = g.c * q[0] + g.s * q[1], qn = -g.s * q[0] + g.c * q[1], f = w / 2 * g.L * 2 * Math.PI * r, S = axiShape(xi, g.L);
      fl[0] += f * (1 - xi) * qt; fl[3] += f * xi * qt;
      fl[1] += f * S.H[0] * qn; fl[2] += f * S.H[1] * qn; fl[4] += f * S.H[2] * qn; fl[5] += f * S.H[3] * qn;
    });
    const T = axiT(g), fg = new Float64Array(6);
    for (let i = 0; i < 6; i++) { let s = 0; for (let a = 0; a < 6; a++) s += T[a][i] * fl[a]; fg[i] = s; }
    return { fl, fg };
  }
  // divide [a, b] passando pelos pontos obrigatórios, com passo ≤ hs
  function axiDiv(a, b, must, hs) {
    const pts = [...new Set([a, b, ...must.filter(x => x > a + 1e-6 && x < b - 1e-6)].map(x => +x.toFixed(6)))].sort((x, y) => x - y), out = [pts[0]];
    for (let i = 1; i < pts.length; i++) { const n = Math.max(1, Math.ceil((pts[i] - pts[i - 1]) / hs - 1e-9)); for (let k = 1; k <= n; k++) out.push(pts[i - 1] + (pts[i] - pts[i - 1]) * k / n); }
    return out;
  }
  // monta a malha meridional: laje de topo (de r0 até o eixo da parede), parede (de cima para baixo) e
  // laje de fundo (do centro até a borda da aba). sign: +1 se a normal local aponta para fora da caixa.
  function axiMesh(g, zMust) {
    const Rc = g.Bc / 2, xf = Rc - g.ep / 2, xo = Rc + g.ep / 2, Rinf = xo + (g.ba || 0), Hc = g.Hc;
    const hs = Math.max(0.01, Math.min(0.025, (g.h || 0.1) / 4));
    const ro = g.bo > 0 ? Math.min(g.bo / 2, xf - 0.05) : 0, chim = ro > 0 && g.chimH > 0;
    const nodes = [], key = new Map(), elems = [];
    const node = (r, z) => { const k = r.toFixed(6) + '|' + z.toFixed(6); if (!key.has(k)) { key.set(k, nodes.length); nodes.push([r, 0, z]); } return key.get(k); };
    const chain = (pts, s, t, sign, Ef) => { for (let i = 1; i < pts.length; i++) elems.push({ s, n: [pts[i - 1], pts[i]], t, sign, Ef: Ef || 1 }); };
    // topo: r crescente; normal local (0, 1) = para cima = para fora
    const rt = axiDiv(ro, Rc, [xf, chim ? ro + g.ep : -1], hs);
    chain(rt.map(r => node(r, Hc)), 'top', g.es, 1, g.noTop ? 1e-4 : 1);
    // parede: z crescente de 0 a Hc (normal local (−1, 0) = para dentro → sign −1)
    const zw = axiDiv(0, Hc, [g.ei / 2, Hc - g.es / 2, ...(zMust || [])], hs);
    chain(zw.map(z => node(Rc, z)), 'wx', g.ep, -1);
    // fundo: r crescente; normal local (0, 1) = para cima = para dentro → sign −1
    const rb = axiDiv(0, Rinf, [xf, Rc, xo], hs);
    chain(rb.map(r => node(r, 0)), 'bot', g.ei, -1);
    return { nodes, elems, geo: { circ: true, Rc, xw: Rc, xf, xo, yw: Rc, yf: xf, yo: xo, Rinf, ro, chim, bo: 2 * ro, lo: 2 * ro } };
  }

  function analyzeAxi(inp) {
    const t0 = Date.now(), L = inp.loads, g = inp.geo, E = inp.mat.E, nu = inp.mat.nu, TWO_PI = 2 * Math.PI;
    const zi = L.hagW > 0 ? g.ei / 2 + L.hagW : -1;
    const mesh = axiMesh(g, [L.dw > L.dA && L.dw < L.dB ? L.dB - L.dw : -1, zi]);
    const G = mesh.geo, nn = mesh.nodes.length, Rc = G.Rc, xf = G.xf, xo = G.xo;
    // numeração: 3 gl por nó; no eixo (r = 0) u_r = β = 0
    const eq = new Int32Array(3 * nn).fill(-1); let n = 0;
    for (let i = 0; i < nn; i++) for (let d = 0; d < 3; d++) if (!(mesh.nodes[i][0] < 1e-9 && d !== 1)) eq[3 * i + d] = n++;
    const EM = mesh.elems.map(e => axiElemK([mesh.nodes[e.n[0]][0], mesh.nodes[e.n[0]][2]], [mesh.nodes[e.n[1]][0], mesh.nodes[e.n[1]][2]], e.t, E * e.Ef, nu));
    const top = new Int32Array(n); for (let i = 0; i < n; i++) top[i] = i;
    const edofs = e => [...e.n.flatMap(i => [eq[3 * i], eq[3 * i + 1], eq[3 * i + 2]])];
    mesh.elems.forEach(e => { const d = edofs(e).filter(q => q >= 0), mn = Math.min(...d); d.forEach(q => { if (mn < top[q]) top[q] = mn; }); });
    const maxa = new Int32Array(n + 1); for (let j = 0; j < n; j++) maxa[j + 1] = maxa[j] + (j - top[j] + 1);
    const a0 = new Float64Array(maxa[n]);
    mesh.elems.forEach((e, k) => { const d = edofs(e), K = EM[k].kg; for (let p = 0; p < 6; p++) { const i = d[p]; if (i < 0) continue; for (let q = 0; q < 6; q++) { const j = d[q]; if (j < 0 || i > j) continue; a0[maxa[j] + (j - i)] += K[p][q]; } } });
    // molas: área do anel de influência de cada nó da laje de fundo
    const trib = new Float64Array(nn);
    mesh.elems.forEach(e => { if (e.s !== 'bot') return; const r1 = mesh.nodes[e.n[0]][0], r2 = mesh.nodes[e.n[1]][0], rm = (r1 + r2) / 2; trib[e.n[0]] += Math.PI * (rm * rm - r1 * r1); trib[e.n[1]] += Math.PI * (r2 * r2 - rm * rm); });
    const springNodes = []; for (let i = 0; i < nn; i++) if (trib[i] > 0) springNodes.push(i);

    // ---- cargas: 0 permanentes verticais, 1 empuxo + água externa, 2 sobrecarga vertical, 3 sobrecarga lateral,
    // 4 subpressão separada (etapa construtiva), 5 água interna. Pressões laterais da face externa (raio x_o) e da
    // interna (x_f) levadas ao eixo da parede pela razão dos raios.
    const dS = Math.max(0, L.dw);
    const sh = d => Math.max(0, L.K * (d <= dS ? L.gd * d : L.gd * dS + L.gp * (d - dS)) - L.cT);
    const uw = d => L.gw * Math.max(0, d - L.dw);
    const pg = d => sh(d) + uw(d), depth = z => L.dB - z, kO = xo / Rc, kI = xf / Rc;
    const inRing = r => G.chim && r < G.ro + g.ep + 1e-9;
    const comps = [
      (r, z, e) => e.s === 'top' ? [0, -(L.qtSelf + (inRing(r) ? L.qChim : L.qtSoil))] : e.s === 'bot' ? [0, -L.qbSelf + (L.sepU ? 0 : L.uBase) - (r > xo + 1e-9 ? L.qAba : 0)] : [0, -L.wallW],
      (r, z, e) => e.s === 'wx' ? [-pg(depth(z)) * kO, 0] : null,
      (r, z, e) => e.s === 'top' ? [0, -L.q] : (e.s === 'bot' && r > xo + 1e-9) ? [0, -L.q] : null,
      (r, z, e) => e.s === 'wx' ? [-L.Kq * kO, 0] : null,
      (r, z, e) => L.sepU && e.s === 'bot' ? [0, L.uBase - (r > xo + 1e-9 ? (L.qAbaW || 0) : 0)] : null,
      (r, z, e) => !(L.hagW > 0) ? null : e.s === 'wx' ? (z >= g.ei / 2 - 1e-9 && z < zi ? [L.gwI * (zi - z) * kI, 0] : null) : (e.s === 'bot' && r < xf - 1e-9) ? [0, -L.gwI * L.hagW] : null
    ];
    const EF = comps.map(fn => mesh.elems.map(e => { const P1 = mesh.nodes[e.n[0]], P2 = mesh.nodes[e.n[1]]; return axiElemF([P1[0], P1[2]], [P2[0], P2[2]], (r, z) => fn(r, z, e)); }));
    const F = EF.map(list => { const Fv = new Float64Array(n); list.forEach((ef, k) => { const d = edofs(mesh.elems[k]); for (let p = 0; p < 6; p++) if (d[p] >= 0) Fv[d[p]] += ef.fg[p]; }); return Fv; });
    // cargas de anel (força total do anel) nos cantos: faixa da laje de topo além do eixo e pressão lateral
    // nas meias espessuras das lajes, na face externa
    const integ = (f, a, b) => { const m = 40, hh = (b - a) / m; let s = 0; for (let i = 0; i <= m; i++) s += f(a + i * hh) * ((i === 0 || i === m) ? 0.5 : 1); return s * hh; };
    const cTop = mesh.nodes.findIndex(q => Math.abs(q[0] - Rc) < 1e-7 && Math.abs(q[2] - g.Hc) < 1e-7), cBot = mesh.nodes.findIndex(q => Math.abs(q[0] - Rc) < 1e-7 && Math.abs(q[2]) < 1e-7);
    const add = (k, nd, d, v) => { const q = eq[3 * nd + d]; if (q >= 0) F[k][q] += v; };
    const Astrip = Math.PI * (xo * xo - Rc * Rc);
    add(0, cTop, 1, -(L.qtSelf + L.qtSoil) * Astrip); add(2, cTop, 1, -L.q * Astrip);
    add(1, cTop, 0, -integ(pg, L.dA - g.es / 2, L.dA) * TWO_PI * xo); add(1, cBot, 0, -integ(pg, L.dB, L.dB + g.ei / 2) * TWO_PI * xo);
    add(3, cTop, 0, -L.Kq * g.es / 2 * TWO_PI * xo); add(3, cBot, 0, -L.Kq * g.ei / 2 * TWO_PI * xo);
    const Fz = F.map(Fv => { let s = 0; for (let i = 0; i < nn; i++) { const q = eq[3 * i + 1]; if (q >= 0) s += Fv[q]; } return s; });
    // parcelas nodais das cargas de anel (para as forças de extremidade dos elementos)
    const ring = F.map(() => new Map());
    const ringAdd = (k, nd, d, v) => { const m = ring[k]; const a = m.get(nd) || [0, 0, 0]; a[d] += v; m.set(nd, a); };
    ringAdd(0, cTop, 1, -(L.qtSelf + L.qtSoil) * Astrip); ringAdd(2, cTop, 1, -L.q * Astrip);

    // ---- solução com molas só de compressão
    const solveWith = (active, rhsList) => {
      const a = new Float64Array(a0);
      springNodes.forEach(i => { if (active[i]) { const q = eq[3 * i + 1]; if (q >= 0) a[maxa[q]] += inp.kv * trib[i]; } });
      if (!factor(a, maxa, n)) return null;
      return rhsList.map(r => backsub(a, maxa, n, Float64Array.from(r)));
    };
    const allOn = new Uint8Array(nn).fill(1);
    let nFact = 1;
    const base = solveWith(allOn, F);
    if (!base) return { error: 'A matriz de rigidez não é positiva definida. Confira a geometria e o coeficiente de mola.' };
    const uzOf = (U, i) => { const q = eq[3 * i + 1]; return q >= 0 ? U[q] : 0; };
    const solveCombo = cb => {
      let U = new Float64Array(n); cb.f.forEach((c, k) => { if (c && base[k]) for (let i = 0; i < n; i++) U[i] += c * base[k][i]; });
      let active = allOn, it = 0, lifted = 0;
      if (!cb.lin) {
        for (; it < 25; it++) {
          const next = new Uint8Array(nn); let changed = false, any = false;
          springNodes.forEach(i => { next[i] = uzOf(U, i) <= 0 ? 1 : 0; if (next[i]) any = true; if (next[i] !== active[i]) changed = true; });
          if (!changed) break;
          if (!any) return { U, active: next, floated: true, it };
          const Fc = new Float64Array(n); cb.f.forEach((c, k) => { if (c && F[k]) for (let i = 0; i < n; i++) Fc[i] += c * F[k][i]; });
          const r = solveWith(next, [Fc]); nFact++;
          if (!r) return { U, active: next, floated: true, it };
          U = r[0]; active = next;
        }
        springNodes.forEach(i => { if (!active[i]) lifted++; });
      }
      return { U, active, it, lifted, floated: false };
    };

    // ---- resultantes nas extremidades dos elementos, médias nos nós de cada superfície
    // N_s, Q e M_s pelas forças de extremidade (equilíbrio exato); N_θ e M_θ pelas deformações
    const surfNodes = { top: [], wx: [], bot: [] }, surfIdx = {};
    mesh.elems.forEach(e => e.n.forEach(i => { if (!surfNodes[e.s].includes(i)) surfNodes[e.s].push(i); }));
    Object.keys(surfNodes).forEach(s => { surfNodes[s].sort((a, b) => s === 'wx' ? mesh.nodes[a][2] - mesh.nodes[b][2] : mesh.nodes[a][0] - mesh.nodes[b][0]); surfIdx[s] = new Map(surfNodes[s].map((i, j) => [i, j])); });
    const resultants = (U, cb) => {
      const out = {}, cnt = {};
      Object.keys(surfNodes).forEach(s => { out[s] = new Float64Array(8 * surfNodes[s].length); cnt[s] = new Float64Array(surfNodes[s].length); });
      mesh.elems.forEach((e, k) => {
        const M = EM[k], g2 = M.g, dg = edofs(e).map(q => q >= 0 ? U[q] : 0);
        const dl = new Float64Array(6); for (let i = 0; i < 6; i++) { let s = 0; for (let a = 0; a < 6; a++) s += M.T[i][a] * dg[a]; dl[i] = s; }
        const fl = new Float64Array(6); for (let i = 0; i < 6; i++) { let s = 0; for (let a = 0; a < 6; a++) s += M.kl[i][a] * dl[a]; fl[i] = s; }
        cb.f.forEach((c, kk) => { if (c && EF[kk]) { const L2 = EF[kk][k].fl; for (let i = 0; i < 6; i++) fl[i] -= c * L2[i]; } });
        [0, 1].forEach(end => {
          const nd = e.n[end], r = mesh.nodes[nd][0], xi = end === 0 ? (r < 1e-9 ? 1e-4 : 0) : (r < 1e-9 ? 1 - 1e-4 : 1);
          const rr = Math.max(r, 1e-9), B = axiB(xi, r < 1e-9 ? (mesh.nodes[e.n[0]][0] + (mesh.nodes[e.n[1]][0] - mesh.nodes[e.n[0]][0]) * xi) : r, g2);
          const eps = B.map(row => row.reduce((s, v, j) => s + v * dl[j], 0)), D = M.D;
          const Ns_e = D[0][0] * eps[0] + D[0][1] * eps[1], Nt = D[1][0] * eps[0] + D[1][1] * eps[1];
          const Ms_e = D[2][2] * eps[2] + D[2][3] * eps[3], Mt = D[3][2] * eps[2] + D[3][3] * eps[3];
          let Ns, Q, Ms;
          if (r < 1e-9) { Ns = Ns_e; Ms = Ms_e; Q = 0; }
          else {
            const sg = end === 0 ? -1 : 1, base3 = 3 * end, den = TWO_PI * rr;
            Ns = sg * fl[base3] / den; Q = sg * fl[base3 + 1] / den; Ms = -sg * fl[base3 + 2] / den;
          }
          const sgn = e.sign, j = surfIdx[e.s].get(nd), o = 8 * j, R = out[e.s];
          // ordem das resultantes: [M1, M2, M12, Q1, Q2, N1, N2, N12]; topo: 1 = radial; parede e fundo: 1 = anelar/tangencial
          const vals = e.s === 'top' ? [sgn * Ms, sgn * Mt, 0, sgn * Q, 0, Ns, Nt, 0] : [sgn * Mt, sgn * Ms, 0, 0, sgn * Q, Nt, Ns, 0];
          for (let a = 0; a < 8; a++) R[o + a] += vals[a];
          cnt[e.s][j]++;
        });
      });
      Object.keys(out).forEach(s => { const R = out[s], C = cnt[s]; for (let j = 0; j < C.length; j++) if (C[j] > 1) for (let a = 0; a < 8; a++) R[8 * j + a] /= C[j]; });
      return out;
    };
    const disp = U => { const d = new Float64Array(nn * 3); for (let i = 0; i < nn; i++) { const qr = eq[3 * i], qz = eq[3 * i + 1]; d[3 * i] = qr >= 0 ? U[qr] : 0; d[3 * i + 2] = qz >= 0 ? U[qz] : 0; } return d; };
    const results = inp.combos.map(cb => {
      const r = solveCombo(cb);
      let R = 0; const press = new Float64Array(nn);
      springNodes.forEach(i => { if (r.active[i]) { const w = uzOf(r.U, i); press[i] = Math.max(0, -inp.kv * w); R += press[i] * trib[i]; } });
      const Fapp = cb.f.reduce((s, c, k) => s + (c && Fz[k] ? c * Fz[k] : 0), 0);
      return { res: resultants(r.U, cb), disp: disp(r.U), press, R, Fz: -Fapp, lifted: r.lifted, floated: r.floated, it: r.it };
    });
    return {
      nodes: mesh.nodes, elems: mesh.elems.map(e => ({ s: e.s, n: e.n })), geo: G, surfNodes, results, circ: true,
      stats: { nElem: mesh.elems.length, nNode: nn, nEq: n, nnz: maxa[n], nFact, ms: Date.now() - t0 }
    };
  }

  return { analyze, analyzeAxi, axiElemK, axiElemF, axiMesh, buildBox, elemMats, prepare, areaLoad, factor, backsub, SURF, recovery, nodal, gaussValues };
}
if (typeof window !== 'undefined') window.FEengine = FEengine;
if (typeof module !== 'undefined' && module.exports) module.exports = FEengine;
