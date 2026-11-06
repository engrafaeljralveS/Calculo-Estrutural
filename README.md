# Cálculo Estrutural — conjunto de programas

Página única que reúne os programas de cálculo estrutural. O índice à esquerda lista os programas por disciplina; ao clicar, o programa abre na área da direita.

Acesse: https://engrafaeljralves.github.io/Calculo-Estrutural/

| Disciplina | Programa | Versão |
|---|---|---|
| Concreto armado | Calculadora de Concreto Armado | NBR 6118 |
| Fundações | Verificação de Recalque | V1.2 |
| Contenções e muros | Muro de Vedação | v13 |
| Contenções e muros | Muro de Contenção | v1.0 |
| Contenções e muros | Alas | v1.11 |
| Reservatórios e caixas | Flutuação em Caixas | v4 |
| Saneamento | Bloco de Ancoragem | V2.9 |

Cada programa fica em `apps/` como um arquivo HTML independente. Os dados digitados ficam salvos no navegador de quem usa.

Abra um programa direto pelo endereço com `#` e o nome do arquivo, por exemplo `#muro-vedacao` ou `#bloco-ancoragem`.

## Motores

A pasta `motores/` guarda o código reaproveitável entre os programas, com a documentação em [`motores/LEIAME.md`](motores/LEIAME.md):

- `motor-elementos-finitos.js`: análise de caixas de concreto por elementos finitos de casca (retangular em 1/4 ou circular axissimétrica), com molas de Winkler só de compressão.
- `visualizador-3d.js`: visualizador 3D de estruturas e resultados (mapa de cores, deformada, corte, zoom e leitura do valor no clique).

Resultados preliminares: confira o dimensionamento conforme as normas e o projeto.
