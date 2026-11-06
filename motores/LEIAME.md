# Motores do conjunto Cálculo Estrutural

Código reaproveitável entre os programas. Cada motor é um arquivo `.js` independente, sem dependência dos programas.

| Arquivo | O que faz | Usado em |
|---|---|---|
| `motor-elementos-finitos.js` | Análise por elementos finitos de casca de caixas de concreto (retangular em 1/4 ou circular axissimétrica), com molas de Winkler só de compressão | Flutuação em Caixas (cópia interna), Alas (versão adaptada) |
| `visualizador-3d.js` | Visualizador 3D: superfícies com mapa de cores, deformada, sólidos, setas, corte, zoom e leitura do valor no clique | Flutuação em Caixas, aba Esforços (Esforços em 3D) |

Versões: motor de elementos finitos 1.0 e visualizador 3D 1.2, novembro de 2026.

---

## 1. Motor de elementos finitos (`FEengine`)

```html
<script src="../motores/motor-elementos-finitos.js"></script>
<script>
  const FE = FEengine();
  const r = FE.analyze(inp);
</script>
```

Também roda num Web Worker: `new Worker(URL.createObjectURL(new Blob([FEengine.toString() + '...'])))`. É assim que o Flutuação em Caixas faz, para a tela não travar.

### Entrada `inp`

```js
{
  geo:  { Bc, Lc, Hc, ep, es, ei, ba, bo, lo, chimH, h, circ?, noTop? },
  mat:  { E, nu },          // E em kPa (ex.: Ecs do concreto × 1000), nu = 0,2
  kv,                       // coeficiente de mola do solo (kN/m³)
  loads: { ... },           // intensidades das ações (abaixo)
  combos: [ { f: [6 fatores], lin?: true }, ... ]
}
```

**Geometria (m), medidas nos eixos das peças**

| Campo | Significado |
|---|---|
| `Bc`, `Lc` | Vãos entre eixos das paredes (B + e<sub>p</sub>, L + e<sub>p</sub>); no modelo circular, `Bc` é o diâmetro do eixo da parede |
| `Hc` | Altura entre eixos das lajes: H + (e<sub>s</sub> + e<sub>i</sub>)/2 |
| `ep`, `es`, `ei` | Espessuras: parede, laje de topo, laje de fundo |
| `ba` | Aba da laje de fundo além da face externa da parede |
| `bo`, `lo` | Abertura na laje de topo (0 = sem abertura) |
| `chimH` | Altura da chaminé sobre a abertura |
| `h` | Tamanho máximo do elemento (a malha refina até e/4 junto às ligações) |
| `circ` | `true` para caixa circular (modelo axissimétrico) |
| `noTop` | `true` tira a rigidez da laje de topo (etapa construtiva) |

**Ações por componente.** Cada combinação multiplica 6 componentes de carga pelos fatores `f`:

| Índice | Componente | Campos de `loads` que usa |
|---|---|---|
| 0 | Permanentes verticais (pesos, solo sobre as lajes) | `qtSelf`, `qtSoil`, `qChim`, `qbSelf`, `qAba`, `wallW`, `uBase` (quando `sepU` é falso) |
| 1 | Empuxo do solo e água externa nas paredes | `K`, `gd`, `gp`, `gw`, `dw`, `cT`, `dA`, `dB` |
| 2 | Sobrecarga vertical | `q` |
| 3 | Sobrecarga lateral | `Kq` |
| 4 | Subpressão separada (etapa construtiva, com `sepU: true`) | `uBase`, `qAbaW` |
| 5 | Água interna | `gwI`, `hagW` |

Unidades: pressões em kPa, pesos específicos em kN/m³, profundidades em m. `K` é o coeficiente de empuxo (K<sub>0</sub> ou K<sub>a</sub>), `gp` é γ′ = γ<sub>sat</sub> − γ<sub>w</sub>, `dw` é a profundidade do N.A., `cT` é o termo da coesão (2c√K<sub>a</sub>), e `dA` e `dB` são as profundidades do eixo da laje de topo e da base. A forma de montar `loads` e `combos` a partir dos dados da obra está em `Arm.feInput(m)` no Flutuação em Caixas, que é o melhor modelo para copiar.

`lin: true` resolve a combinação como linear, com todas as molas ativas. Sem ela, o motor itera as molas só de compressão e marca `lifted` (molas descoladas) e `floated` (caixa sem apoio).

### Saída

| Campo | Conteúdo |
|---|---|
| `nodes` | `[[x, y, z]]` em m. No modelo circular, `[r, 0, z]` |
| `elems` | `[{ s, n }]`: superfície (`top`, `bot`, `wx`, `wy`) e nós (4 no retangular, 2 no circular) |
| `surfNodes` | Nós de cada superfície, na ordem das resultantes |
| `results[k].res[s]` | 8 valores por nó: `[M1, M2, M12, Q1, Q2, N1, N2, N12]` nos eixos locais da superfície. M > 0 traciona a face externa; N > 0 é tração |
| `results[k].disp` | 3 valores por nó (m): x, y, z |
| `results[k].press` | Pressão de contato nas molas (kPa) |
| `results[k].R`, `Fz` | Reação total e carga vertical aplicada (kN, caixa inteira), para conferir o equilíbrio |
| `stats` | Elementos, nós, equações e tempo (ms) |

**Eixos locais (direção 1 / 2):**

| Superfície | 1 | 2 |
|---|---|---|
| `top` laje de topo | paralela a B (x) | paralela a L (y) |
| `bot` laje de fundo | paralela a L (y) | paralela a B (x) |
| `wx` parede em x = Bc/2 | horizontal (y) | vertical (z) |
| `wy` parede em y = Lc/2 | vertical (z) | horizontal (x) |

No circular: laje de topo 1 = radial; parede e laje de fundo 1 = anelar (tangencial).

**Simetria.** O modelo retangular é 1/4 da caixa (x ≥ 0, y ≥ 0). Para ver a caixa inteira, espelhe em x e em y. Ao espelhar, trocam de sinal as componentes listadas na tabela `FLIP` do Flutuação em Caixas (cortantes e volventes perpendiculares ao plano de simetria). Os momentos fletores e os normais não trocam.

---

## 2. Visualizador 3D (`Motor3D`)

Depende do three.js r128 e do OrbitControls, que `Motor3D.carregar()` busca sozinho no cdnjs e no jsDelivr.

```html
<div id="caixa3d" style="height:520px"></div>
<script src="../motores/visualizador-3d.js"></script>
<script>
  await Motor3D.carregar();
  const v = Motor3D.criar(document.getElementById('caixa3d'));
  const esc = Motor3D.escala(valores, { tipo: 'arco-iris', faixas: 12 });
  v.superficie({ nos, quads, valores, escala: esc, arestas: true });
  v.ajustar();
  document.getElementById('legenda').innerHTML = Motor3D.legendaHTML(esc, 'kN·m/m', null, { vertical: true });
  v.aoClicar(h => h && console.log(h.valor, h.ponto));
</script>
```

Eixos de engenharia: x e y horizontais, z vertical para cima. O motor converte para o three.js internamente. As cores podem ser CSS (`#2b6cb0`) ou variáveis do tema (`--pos`, `--neg`, `--concrete`, `--bg`, `--ink`), que o motor lê da página.

### Funções do módulo

| Função | O que faz |
|---|---|
| `Motor3D.carregar()` | Promise que carrega o three.js e os controles de órbita, se ainda não estiverem na página |
| `Motor3D.criar(elemento, { fundo })` | Cria o visualizador dentro do elemento (que precisa ter altura). Devolve `v` |
| `Motor3D.escala(valores, opts)` | Escala de cores. `tipo: 'arco-iris'` (várias cores, maior valor em vermelho; `faixas: 12` dá faixas nítidas como nos programas de análise, `faixas: 0` é contínua; quando o mínimo é 0, começa num tom claro), `'divergente'` (azul · branco · laranja, simétrica no zero) ou `'sequencial'`. `limites: [mín, máx]` fixa os extremos; `cores: { neg, zero, pos }`; `paleta: [cores]` troca o arco-íris |
| `Motor3D.legendaHTML(esc, unidade, fmt?, { vertical })` | Barra horizontal com os extremos, ou, com `vertical: true` no arco-íris, coluna de faixas com o valor de cada divisa (máximo em cima), para pôr sobre a vista. O motor injeta um estilo padrão (classes `m3-*`) |
| `Motor3D.espelhar(malha, planos)` | Espelha uma malha de 1/4 ou 1/2. Devolve `nos`, `quads`, `origem` (nó original) e `imagem` (`[sx, sy]`), para aplicar a troca de sinal |
| `Motor3D.revolver(perfil, n)` | Gira um perfil axissimétrico `{ nos: [[r, 0, z]], segs: [[a, b]] }` em n divisões. Devolve `nos`, `quads`, `origem`, `ang` |

### Métodos do visualizador `v`

| Método | O que faz |
|---|---|
| `v.superficie({ nos, quads \| tris, valores?, escala?, cor?, opacidade?, arestas?, desloc?, fator?, info? })` | Casca com mapa de cores por nó (ou cor única), deformada (`desloc` por nó × `fator`) e contorno dos elementos |
| `v.solido(l, c, circ, furos, z0, z1, { cor, opacidade, arestas, x0, y0 })` | Prisma vertical com contorno retangular l × c (ou círculo de diâmetro l) e furos, entre as cotas z0 e z1 |
| `v.seta(origem, direcao, comprimento, cor)` | Seta de carregamento |
| `v.linha(pontos, cor, fechada?, opacidade?)` | Linha poligonal |
| `v.ponto(p, cor, raio)` | Marcador esférico, para máximo e mínimo |
| `v.corte(ativo, { normal, d }?)` | Corte por um plano. O padrão corta ao meio e mantém y ≥ 0 |
| `v.ajustar(caixa?, direcao?)` | Enquadra o conteúdo |
| `v.zoom(f)` | f < 1 aproxima, f > 1 afasta |
| `v.aoClicar(fn)` | Leitura no clique: `fn({ ponto, valor, no, info })` com o valor interpolado no triângulo atingido |
| `v.limpar()`, `v.render()`, `v.tamanho()`, `v.destruir()` | Manutenção da cena |
| `v.three` | Acesso direto a `cena`, `camera`, `controles` e `renderer`, para casos especiais |

### Receita: resultados do motor de elementos finitos em 3D

O adaptador completo está em `apps/flutuacao.html`, no bloco `E3` (Esforços em 3D). Em resumo:

1. Para cada superfície `s`, pegue os elementos `elems.filter(e => e.s === s)` e os nós `surfNodes[s]`.
2. Retangular: `Motor3D.espelhar(malha, [[1,1],[-1,1],[1,-1],[-1,-1]])`. Circular: `Motor3D.revolver(...)`.
3. Para cada nó novo, leia o valor do nó de origem em `results[k].res[s]` e troque o sinal se a componente inverter naquele espelho.
4. Monte a escala com os extremos da região de interesse e chame `v.superficie(...)` para cada superfície.
5. Deformada: `desloc` com `disp` espelhado (dx·sx, dy·sy, dz) e `fator` para que o maior deslocamento fique com uns 6% do tamanho da caixa.

---

## Para usar num programa novo

1. Copie a pasta `motores/` para junto do programa, ou referencie `../motores/...` dentro do conjunto.
2. Carregue o motor com `<script src="...">` antes do código do programa.
3. Monte a entrada no formato acima. Um programa novo de caixa pode copiar `Arm.feInput` do Flutuação em Caixas e trocar só as cargas.

Ao corrigir um motor, atualize a versão no cabeçalho do arquivo e nesta página, e confira os programas que o usam.
