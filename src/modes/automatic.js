const fs = require('fs');
const path = require('path');
const {
    spawn,
    execFileSync
} = require('child_process');

const complexity =
    require('../analysis/complexity');

const segments =
    require('../processing/segments');

const vmaf =
    require('../analysis/vmaf');

const ROOT_DIR =
    path.resolve(
        __dirname,
        '../..'
    );

const OUTPUT_DIR =
    path.join(
        ROOT_DIR,
        'processed'
    );

const TEMP_DIR =
    path.join(
        ROOT_DIR,
        '.tmp'
    );

const INITIAL_CQ_VALUES = [
    20,
    23,
    26
];

const VMAF_TARGET = 95;

const VMAF_MIN_SAMPLE = 92;

const PRESET = 'p5';

const COMPLEXITY_SAMPLES = 5;

function getVideoTempDir(
    inputFile
) {
    const videoTempDir =
        path.join(
            TEMP_DIR,
            path.basename(inputFile)
        );

    fs.mkdirSync(
        videoTempDir,
        {
            recursive: true
        }
    );

    return videoTempDir;
}

function formatBytes(bytes) {
    const units = [
        'B',
        'KB',
        'MB',
        'GB',
        'TB'
    ];

    let size = bytes;
    let unit = 0;

    while (
        size >= 1024 &&
        unit < units.length - 1
    ) {
        size /= 1024;
        unit++;
    }

    return `${size.toFixed(2)} ${units[unit]}`;
}

function getVideos() {
    return fs
        .readdirSync(
            ROOT_DIR
        )
        .filter(
            file =>
                path.extname(file)
                    .toLowerCase() ===
                '.mp4'
        );
}

function checkFFmpeg() {
    try {
        execFileSync(
            'ffmpeg',
            ['-version'],
            {
                stdio: 'ignore',
                windowsHide: true
            }
        );
    } catch {
        console.error(
            '\n❌ FFmpeg não encontrado.'
        );

        console.error(
            'Verifique se o FFmpeg está instalado e disponível no PATH do Windows.'
        );

        return false;
    }

    try {
        const encoders =
            execFileSync(
                'ffmpeg',
                [
                    '-hide_banner',
                    '-encoders'
                ],
                {
                    encoding: 'utf8',
                    windowsHide: true
                }
            );

        if (
            !encoders.includes(
                'hevc_nvenc'
            )
        ) {
            console.error(
                '\n❌ NVENC não está disponível no FFmpeg.'
            );

            return false;
        }
    } catch {
        console.error(
            '\n❌ Não foi possível verificar o suporte ao NVENC.'
        );

        return false;
    }

    try {
        const filters =
            execFileSync(
                'ffmpeg',
                [
                    '-hide_banner',
                    '-filters'
                ],
                {
                    encoding: 'utf8',
                    windowsHide: true
                }
            );

        if (
            !filters.includes(
                'libvmaf'
            )
        ) {
            console.error(
                '\n❌ VMAF não está disponível no FFmpeg.'
            );

            return false;
        }
    } catch {
        console.error(
            '\n❌ Não foi possível verificar o suporte ao VMAF.'
        );

        return false;
    }

    return true;
}

function getVideoDuration(
    inputPath
) {
    try {
        const result =
            execFileSync(
                'ffprobe',
                [
                    '-v',
                    'error',

                    '-show_entries',
                    'format=duration',

                    '-of',
                    'default=noprint_wrappers=1:nokey=1',

                    inputPath
                ],
                {
                    encoding: 'utf8',
                    windowsHide: true
                }
            );

        const duration =
            Number(
                result.trim()
            );

        if (
            !Number.isFinite(
                duration
            )
        ) {
            throw new Error(
                'Duração inválida.'
            );
        }

        return duration;

    } catch {
        throw new Error(
            `Não foi possível obter a duração do vídeo:\n${inputPath}`
        );
    }
}

function isApproved(
    result
) {
    return (
        result.average >=
        VMAF_TARGET &&
        result.minimum >=
        VMAF_MIN_SAMPLE
    );
}

async function findBestCQ(
    referencePath,
    sampleCount,
    duration,
    tempDir
) {
    console.log(
        '\n🔬 Testando qualidade automaticamente...'
    );

    console.log(
        `   CQs iniciais: ${INITIAL_CQ_VALUES.join(', ')}`
    );

    console.log(
        `   VMAF médio mínimo: ${VMAF_TARGET}`
    );

    console.log(
        `   VMAF mínimo por amostra: ${VMAF_MIN_SAMPLE}`
    );

    const results = [];

    for (
        const cq of INITIAL_CQ_VALUES
    ) {
        const tested =
            await vmaf.testCQs(
                referencePath,
                [cq],
                tempDir,
                sampleCount,
                sampleCount
            );

        results.push(
            ...tested
        );
    }

    if (
        results.length === 0
    ) {
        throw new Error(
            'Nenhum teste de CQ foi concluído com sucesso.'
        );
    }

    results.sort(
        (a, b) =>
            a.cq - b.cq
    );

    while (true) {
        const approved =
            results.filter(
                isApproved
            );

        if (
            approved.length === 0
        ) {
            break;
        }

        const highestApproved =
            Math.max(
                ...approved.map(
                    result =>
                        result.cq
                )
            );

        const failedAbove =
            results
                .filter(
                    result =>
                        result.cq >
                            highestApproved &&
                        !isApproved(
                            result
                        )
                )
                .sort(
                    (a, b) =>
                        a.cq - b.cq
                );

        if (
            failedAbove.length === 0
        ) {
            break;
        }

        const lower =
            highestApproved;

        const upper =
            failedAbove[0].cq;

        if (
            upper - lower <= 1
        ) {
            break;
        }

        const middle =
            Math.floor(
                (lower + upper) / 2
            );

        const tested =
            await vmaf.testCQs(
                referencePath,
                [middle],
                tempDir,
                sampleCount,
                sampleCount
            );

        results.push(
            ...tested
        );

        results.sort(
            (a, b) =>
                a.cq - b.cq
        );
    }

    const approved =
        results.filter(
            isApproved
        );

    if (
        approved.length > 0
    ) {
        const best =
            approved.reduce(
                (current, result) =>
                    result.cq >
                    current.cq
                        ? result
                        : current
            );

        console.log(
            `\n   🎯 CQ escolhido: ${best.cq}`
        );

        console.log(
            `   📈 VMAF médio: ${best.average.toFixed(2)}`
        );

        console.log(
            `   📉 VMAF mínimo: ${best.minimum.toFixed(2)}`
        );

        console.log(
            '   ✅ VMAF mínimo atingido.'
        );

        return best.cq;
    }

    const best =
        results.reduce(
            (current, result) => {
                if (
                    result.average >
                    current.average
                ) {
                    return result;
                }

                if (
                    result.average ===
                        current.average &&
                    result.minimum >
                        current.minimum
                ) {
                    return result;
                }

                return current;
            }
        );

    console.log(
        `\n   ⚠️ Nenhum CQ atingiu VMAF ${VMAF_TARGET}.`
    );

    console.log(
        `   🎯 CQ escolhido: ${best.cq}`
    );

    console.log(
        `   📈 Melhor VMAF médio: ${best.average.toFixed(2)}`
    );

    console.log(
        `   📉 VMAF mínimo: ${best.minimum.toFixed(2)}`
    );

    return best.cq;
}

function showProgress(
    current,
    total,
    label,
    forceComplete = false
) {
    const width = 24;

    let percentage =
        total > 0
            ? (current / total) * 100
            : 0;

    if (forceComplete) {
        percentage = 100;
    } else {
        percentage = Math.min(
            99,
            Math.max(0, percentage)
        );
    }

    const filled =
        Math.round(
            (percentage / 100) * width
        );

    const bar =
        '█'.repeat(filled) +
        '░'.repeat(width - filled);

    process.stdout.write(
        `\r   ⏳ ${label}: ${bar} ${percentage.toFixed(0)}%`
    );
}

function parseTimeToSeconds(
    value
) {
    const parts =
        value.split(':');

    if (
        parts.length !== 3
    ) {
        return null;
    }

    const hours =
        Number(parts[0]);

    const minutes =
        Number(parts[1]);

    const seconds =
        Number(parts[2]);

    if (
        !Number.isFinite(hours) ||
        !Number.isFinite(minutes) ||
        !Number.isFinite(seconds)
    ) {
        return null;
    }

    return (
        hours * 3600 +
        minutes * 60 +
        seconds
    );
}

function processVideo(
    inputFile,
    index,
    total,
    cq,
    duration
) {
    return new Promise(
        (resolve, reject) => {
            const inputPath =
                path.join(
                    ROOT_DIR,
                    inputFile
                );

            const outputName =
                path.basename(
                    inputFile,
                    path.extname(
                        inputFile
                    )
                ) + '.mp4';

            const outputPath =
                path.join(
                    OUTPUT_DIR,
                    outputName
                );

            console.log(
                `\n[${index}/${total}] 🎬 ${inputFile}`
            );

            console.log(
                `   🎯 CQ escolhido: ${cq}`
            );

            const startTime =
                Date.now();

            const args = [
                '-hide_banner',
                '-loglevel',
                'error',

                '-progress',
                'pipe:1',

                '-stats_period',
                '0.5',

                '-i',
                inputPath,

                '-c:v',
                'hevc_nvenc',

                '-cq',
                String(cq),

                '-preset',
                PRESET,

                '-c:a',
                'copy',

                '-map_metadata',
                '0',

                '-map_chapters',
                '0',

                '-tag:v',
                'hvc1',

                '-y',
                outputPath
            ];

            const ffmpeg =
                spawn(
                    'ffmpeg',
                    args,
                    {
                        windowsHide: true
                    }
                );

            let stderrOutput = '';
            let progressBuffer = '';
            let lastTime = 0;

            ffmpeg.stdout.on(
                'data',
                data => {
                    progressBuffer +=
                        data.toString();

                    const lines =
                        progressBuffer.split(
                            /\r?\n/
                        );

                    progressBuffer =
                        lines.pop();

                    for (
                        const line of lines
                    ) {
                        if (
                            !line.startsWith(
                                'out_time='
                            )
                        ) {
                            continue;
                        }

                        const value =
                            line.substring(
                                'out_time='.length
                            );

                        const seconds =
                            parseTimeToSeconds(
                                value
                            );

                        if (
                            seconds === null ||
                            seconds < lastTime
                        ) {
                            continue;
                        }

                        lastTime =
                            seconds;

                        showProgress(
                            seconds,
                            duration,
                            'Processando'
                        );
                    }
                }
            );

            ffmpeg.stderr.on(
                'data',
                data => {
                    stderrOutput +=
                        data.toString();
                }
            );

            ffmpeg.on(
                'error',
                error => {
                    reject(
                        new Error(
                            `Não foi possível executar o FFmpeg.\n${error.message}`
                        )
                    );
                }
            );

            ffmpeg.on(
                'close',
                code => {
                    showProgress(
                        duration,
                        duration,
                        'Processando',
                        true
                    );

                    process.stdout.write(
                        '\n'
                    );

                    if (
                        code !== 0
                    ) {
                        reject(
                            new Error(
                                `FFmpeg terminou com código ${code}.\n\n${stderrOutput}`
                            )
                        );

                        return;
                    }

                    if (
                        !fs.existsSync(
                            outputPath
                        )
                    ) {
                        reject(
                            new Error(
                                'O FFmpeg terminou sem gerar o arquivo de saída.'
                            )
                        );

                        return;
                    }

                    const originalSize =
                        fs.statSync(
                            inputPath
                        ).size;

                    const processedSize =
                        fs.statSync(
                            outputPath
                        ).size;

                    const reduction =
                        (
                            (
                                originalSize -
                                processedSize
                            ) /
                            originalSize
                        ) * 100;

                    const elapsed =
                        (
                            Date.now() -
                            startTime
                        ) / 1000;

                    console.log(
                        '   ✅ Concluído'
                    );

                    console.log(
                        `   Tempo:       ${elapsed.toFixed(1)} s`
                    );

                    console.log(
                        `   Original:    ${formatBytes(originalSize)}`
                    );

                    console.log(
                        `   Processado:  ${formatBytes(processedSize)}`
                    );

                    if (
                        reduction >= 0
                    ) {
                        console.log(
                            `   Redução:     ${reduction.toFixed(1)}%`
                        );
                    } else {
                        console.log(
                            `   Aumento:     ${Math.abs(reduction).toFixed(1)}%`
                        );
                    }

                    resolve({
                        inputFile,
                        originalSize,
                        processedSize,
                        reduction,
                        cq
                    });
                }
            );
        }
    );
}

function resetTempDir() {
    if (
        fs.existsSync(
            TEMP_DIR
        )
    ) {
        fs.rmSync(
            TEMP_DIR,
            {
                recursive: true,
                force: true
            }
        );
    }

    fs.mkdirSync(
        TEMP_DIR,
        {
            recursive: true
        }
    );
}

function waitForExit(
    code = 0
) {
    console.log(
        '\nPressione qualquer tecla para sair...'
    );

    process.stdin.setRawMode(
        true
    );

    process.stdin.resume();

    process.stdin.once(
        'data',
        () => {
            process.exit(code);
        }
    );
}

async function automatic() {
    console.log(
        '========================================'
    );

    console.log(
        '       VIDEO-COMPRESS AUTOMATIC'
    );

    console.log(
        '========================================'
    );

    console.log(
        '\n🗑️ Removendo pasta .tmp da execução anterior...'
    );
    resetTempDir();

    console.log(
        '\n🔍 Verificando ambiente...'
    );

    if (
        !checkFFmpeg()
    ) {
        waitForExit(1);
        return;
    }

    console.log(
        '   ✅ FFmpeg encontrado'
    );

    console.log(
        '   ✅ NVIDIA NVENC disponível'
    );

    console.log(
        '   ✅ VMAF disponível'
    );

    if (
        !fs.existsSync(
            OUTPUT_DIR
        )
    ) {
        fs.mkdirSync(
            OUTPUT_DIR,
            {
                recursive: true
            }
        );
    }

    const videos =
        getVideos();

    if (
        videos.length === 0
    ) {
        console.log(
            '\n⚠️ Nenhum arquivo MP4 encontrado.'
        );

        console.log(
            `\nColoque os vídeos em:\n${ROOT_DIR}`
        );

        waitForExit(0);
        return;
    }

    console.log(
        `\n📁 ${videos.length} vídeo(s) encontrado(s).`
    );

    console.log(
        '🎮 GPU: NVIDIA NVENC'
    );

    console.log(
        '🎞️ Codec: H.265 / HEVC'
    );

    console.log(
        `🔬 CQs iniciais: ${INITIAL_CQ_VALUES.join(', ')}`
    );

    console.log(
        `📈 VMAF médio mínimo: ${VMAF_TARGET}`
    );

    console.log(
        `📉 VMAF mínimo por amostra: ${VMAF_MIN_SAMPLE}`
    );

    console.log(
        `🧠 Trechos complexos: ${COMPLEXITY_SAMPLES}`
    );

    console.log(
        '⚡ Paralelismo: desativado'
    );

    console.log(
        `⚙️ Preset: ${PRESET}`
    );

    console.log(
        '🔊 Áudio: original'
    );

    console.log(
        '🏷️ Metadados: preservados'
    );

    const results = [];

    for (
        let i = 0;
        i < videos.length;
        i++
    ) {
        const video =
            videos[i];

        const outputName =
            path.basename(
                video,
                path.extname(
                    video
                )
            ) + '.mp4';

        const outputPath =
            path.join(
                OUTPUT_DIR,
                outputName
            );

        if (
            fs.existsSync(
                outputPath
            )
        ) {
            continue;
        }

        try {
            /*
             * Cada vídeo possui sua própria pasta temporária,
             * preservada para inspeção após a execução.
             */
            const videoTempDir =
                getVideoTempDir(video);

            const inputPath =
                path.join(
                    ROOT_DIR,
                    video
                );

            const duration =
                getVideoDuration(
                    inputPath
                );

            console.log(
                '\n========================================'
            );

            console.log(
                `🎬 Análise: ${video}`
            );

            console.log(
                `⏱️ Duração: ${duration.toFixed(1)} s`
            );

            /*
             * ETAPA 1
             * Encontra os trechos mais difíceis.
             */
            const complexitySamples =
                await complexity.analyzeVideo(
                    inputPath
                );

            const positions =
                complexitySamples
                    .slice(
                        0,
                        COMPLEXITY_SAMPLES
                    )
                    .map(
                        sample =>
                            sample.start
                    );

            if (
                positions.length === 0
            ) {
                throw new Error(
                    'A análise de complexidade não encontrou trechos válidos.'
                );
            }

            /*
             * ETAPA 2
             * Cria uma referência lossless
             * dos trechos selecionados.
             */
            const segmentData =
                await segments.prepareSegments(
                    inputPath,
                    positions,
                    duration,
                    videoTempDir
                );

            /*
             * A referência possui exatamente
             * 1 segundo por trecho.
             */
            const referenceDuration =
                positions.length;

            /*
             * ETAPA 3
             * Testa os CQs usando a mesma
             * referência lossless.
             */
            const cq =
                await findBestCQ(
                    segmentData.referencePath,
                    positions.length,
                    referenceDuration,
                    videoTempDir
                );

            /*
             * ETAPA 4
             * Compressão final do vídeo inteiro.
             */
            const result =
                await processVideo(
                    video,
                    i + 1,
                    videos.length,
                    cq,
                    duration
                );

            results.push(
                result
            );

        } catch (
            error
        ) {
            console.error(
                `\n   ❌ Erro ao processar ${video}`
            );

            console.error(
                `   ${error.message}`
            );
        }
    }

    console.log(
        '\n========================================'
    );

    console.log(
        '             FINALIZADO'
    );

    console.log(
        '========================================'
    );

    console.log(
        '\n📊 Resumo:'
    );

    let totalOriginal = 0;
    let totalProcessed = 0;

    for (
        const result of results
    ) {
        totalOriginal +=
            result.originalSize;

        totalProcessed +=
            result.processedSize;
    }

    const totalReduction =
        totalOriginal > 0
            ? (
                (
                    totalOriginal -
                    totalProcessed
                ) /
                totalOriginal
            ) * 100
            : 0;

    console.log(
        `   Vídeos processados: ${results.length}/${videos.length}`
    );

    console.log(
        `   Tamanho original:   ${formatBytes(totalOriginal)}`
    );

    console.log(
        `   Tamanho processado:  ${formatBytes(totalProcessed)}`
    );

    if (
        totalReduction >= 0
    ) {
        console.log(
            `   Redução total:       ${totalReduction.toFixed(1)}%`
        );
    } else {
        console.log(
            `   Aumento total:       ${Math.abs(totalReduction).toFixed(1)}%`
        );
    }

    console.log(
        '\n📂 Arquivos salvos em:'
    );

    console.log(
        `   ${OUTPUT_DIR}`
    );

    waitForExit(0);
}

module.exports = automatic;
