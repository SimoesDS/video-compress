# Video Compress

Ferramenta em Node.js para compressão de vídeos utilizando **FFmpeg + NVIDIA NVENC**, com foco em reduzir significativamente o tamanho dos arquivos mantendo alta qualidade visual.

O projeto foi pensado principalmente para vídeos gravados em **GoPro e DJI**, especialmente vídeos em alta resolução como 4K.

## ✨ Recursos

* Compressão utilizando **H.265 / HEVC**
* Codificação via **NVIDIA NVENC (GPU)**
* Preservação do áudio original
* Preservação dos metadados
* Preservação dos capítulos
* Arquivos originais nunca são alterados
* Saída separada na pasta `processed`
* Dois modos de compressão:

  * **Normal**
  * **Automático**
* Modo automático baseado em **VMAF**
* Seleção automática do melhor nível de compressão
* Processamento sequencial para evitar sobrecarga de CPU/RAM/GPU

---

## 📁 Estrutura

```text
video-compress/
├── video-compress/
│   ├── index.js
│   └── modes/
│       ├── normal.js
│       └── automatic.js
│
├── processed/
│
├── video1.mp4
├── video2.mp4
│
├── _start.bat
└── README.md
```

Os vídeos que serão processados devem ser colocados na raiz do projeto.

Os arquivos processados serão salvos automaticamente em:

```text
processed/
```

---

## ⚙️ Requisitos

### Node.js

O projeto utiliza Node.js.

### FFmpeg

É necessário ter o FFmpeg instalado e disponível no `PATH` do Windows.

O FFmpeg precisa possuir suporte para:

* `hevc_nvenc`
* `libvmaf`

Para verificar o NVENC:

```bash
ffmpeg -hide_banner -encoders | findstr /i nvenc
```

Para verificar o VMAF:

```bash
ffmpeg -hide_banner -filters | findstr /i vmaf
```

O resultado esperado para VMAF inclui:

```text
libvmaf
```

### GPU

É necessário possuir uma GPU NVIDIA compatível com **NVENC**.

O projeto utiliza:

```text
hevc_nvenc
```

A CPU não é utilizada para a codificação principal do vídeo.

---

## 🚀 Como usar

Coloque os vídeos `.mp4` na raiz do projeto.

Depois execute:

```text
_start.bat
```

Ou diretamente:

```bash
cd video-compress
node index.js
```

Será exibido o menu:

```text
========================================
           VIDEO-COMPRESS
========================================

Escolha o modo:

  1 - Normal
  2 - Automático
```

---

# 🎬 Modo Normal

O modo normal utiliza uma configuração fixa de compressão.

Atualmente:

```text
Codec:  H.265 / HEVC
Encoder: NVIDIA NVENC
Preset: p5
CQ:     20
```

O áudio é copiado diretamente do arquivo original:

```text
-c:a copy
```

Assim, não ocorre uma nova compressão do áudio.

Também são preservados:

* Metadados
* Capítulos
* Resolução
* FPS
* Estrutura de áudio original

---

# 🤖 Modo Automático

O modo automático tenta encontrar automaticamente o melhor **CQ (Constant Quality)** para cada vídeo.

Em vez de utilizar um valor fixo, o programa realiza pequenos testes antes de processar o vídeo inteiro.

### Como funciona

Inicialmente são testados:

```text
CQ 20
CQ 23
CQ 26
```

Para cada CQ são analisadas três partes do vídeo:

```text
Início
Meio
Final
```

Cada amostra possui:

```text
1 segundo
```

A qualidade é comparada utilizando **VMAF**.

### VMAF

O VMAF é uma métrica de qualidade perceptual desenvolvida para estimar o quanto a qualidade de um vídeo comprimido se aproxima do vídeo original.

O projeto utiliza:

```text
VMAF médio mínimo: 95
VMAF mínimo por amostra: 92
```

Ou seja, um CQ só é considerado aprovado quando:

```text
VMAF médio >= 95
```

e nenhuma das amostras apresenta:

```text
VMAF < 92
```

### Seleção do CQ

O programa procura utilizar o **maior CQ possível** que ainda atenda aos critérios de qualidade.

Como valores maiores de CQ geram maior compressão, isso permite buscar arquivos menores sem simplesmente aplicar uma compressão agressiva de forma indiscriminada.

Exemplo:

```text
CQ 20 → VMAF 98.5 ✅
CQ 23 → VMAF 96.2 ✅
CQ 26 → VMAF 93.4 ❌

→ refinamento automático

CQ 24 → VMAF 95.7 ✅
CQ 25 → VMAF 94.6 ❌

→ CQ escolhido: 24
```

Depois da análise, o vídeo inteiro é processado **uma única vez** utilizando o CQ escolhido.

---

## 🧠 Por que HEVC?

O H.265/HEVC possui uma eficiência de compressão superior ao H.264 em diversas situações.

Isso permite reduzir significativamente o tamanho dos arquivos mantendo uma qualidade visual próxima ao original.

Por exemplo:

```text
Original:    130 Mbps
Processado:   48 Mbps
```

Uma redução de bitrate não significa necessariamente uma perda proporcional de qualidade, pois o HEVC consegue representar o conteúdo utilizando menos dados.

---

## 🎮 NVIDIA NVENC

A codificação principal utiliza a GPU NVIDIA:

```text
hevc_nvenc
```

Isso evita depender da codificação `libx265` via CPU.

O preset utilizado atualmente é:

```text
p5
```

---

## 🔊 Áudio

O áudio não é recodificado.

É utilizado:

```text
-c:a copy
```

Isso significa que o áudio original é mantido sem perda adicional causada por uma nova compressão.

---

## 🏷️ Metadados

Os metadados do arquivo original são preservados utilizando:

```text
-map_metadata 0
```

Os capítulos também são preservados:

```text
-map_chapters 0
```

Para compatibilidade com HEVC em MP4 é utilizado:

```text
-tag:v hvc1
```

---

## 📦 Arquivos originais

Os arquivos originais nunca são sobrescritos.

Exemplo:

```text
video1.mp4
```

permanece intacto.

O resultado será salvo como:

```text
processed/video1.mp4
```

---

## ⚠️ Observações

O modo automático realiza testes antes da compressão final.

Por isso, ele pode levar mais tempo que o modo normal.

Essa etapa existe justamente para permitir que cada vídeo tenha um nível de compressão diferente de acordo com sua complexidade.

Um vídeo com pouca movimentação pode aceitar um CQ maior, enquanto um vídeo com água, vegetação, movimento rápido ou muitos detalhes pode exigir um CQ menor.

---

## 📊 Resultado

O programa apresenta ao final informações como:

```text
Original:    5.20 GB
Processado:  2.10 GB
Redução:     59.6%
```

No modo automático também são exibidos os resultados dos testes de VMAF e o CQ escolhido.

---

## 🛠️ Tecnologias

* Node.js
* FFmpeg
* NVIDIA NVENC
* H.265 / HEVC
* VMAF
* JavaScript

---

## 📄 Licença

Este projeto pode ser utilizado e modificado conforme os termos definidos pela licença deste repositório.
