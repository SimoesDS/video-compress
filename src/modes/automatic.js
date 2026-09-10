const fs = require('fs');
const path = require('path');
const { spawn, execFileSync } = require('child_process');
const os = require('os');

const ROOT_DIR = path.resolve(__dirname, '../..');
const OUTPUT_DIR = path.join(ROOT_DIR, 'processed');
const TEMP_DIR = path.join(os.tmpdir(), 'video-compress');

// CQs iniciais da análise
const INITIAL_CQ_VALUES = [20, 23, 26];

// VMAF médio mínimo considerado aceitável
const VMAF_TARGET = 95;

// VMAF mínimo permitido em uma amostra individual
const VMAF_MIN_SAMPLE = 92;

// Duração de cada amostra
const TEST_DURATION = 1;

// Pontos analisados no vídeo
const TEST_POSITIONS = [
    0,
    0.50,
    0.90
];

const PRESET = 'p5';

function formatBytes(bytes) {
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];

    let size = bytes;
    let unit = 0;

    while (size >= 1024 && unit < units.length - 1) {
        size /= 1024;
        unit++;
    }

    return `${size.toFixed(2)} ${units[unit]}`;
}

function getVideos() {
    return fs
        .readdirSync(ROOT_DIR)
        .filter(file => path.extname(file).toLowerCase() === '.mp4');
}

function checkFFmpeg() {
    try {
        execFileSync('ffmpeg', ['-version'], {
            stdio: 'ignore',
            windowsHide: true
        });
    } catch {
        console.error('\n❌ FFmpeg não encontrado.');
        console.error(
            'Verifique se o FFmpeg está instalado e disponível no PATH do Windows.'
        );

        return false;
    }

    try {
        const encoders = execFileSync(
            'ffmpeg',
            ['-hide_banner', '-encoders'],
            {
                encoding: 'utf8',
                windowsHide: true
            }
        );

        if (!encoders.includes('hevc_nvenc')) {
            console.error('\n❌ NVENC não está disponível no FFmpeg.');
            console.error(
                'O encoder hevc_nvenc não foi encontrado.'
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
        const filters = execFileSync(
            'ffmpeg',
            ['-hide_banner', '-filters'],
            {
                encoding: 'utf8',
                windowsHide: true
            }
        );

        if (!filters.includes('libvmaf')) {
            console.error('\n❌ VMAF não está disponível no FFmpeg.');
            console.error(
                'O filtro libvmaf não foi encontrado.'
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

function getVideoDuration(inputPath) {
    try {
        const result = execFileSync(
            'ffprobe',
            [
                '-v', 'error',
                '-show_entries', 'format=duration',
                '-of', 'default=noprint_wrappers=1:nokey=1',
                inputPath
            ],
            {
                encoding: 'utf8',
                windowsHide: true
            }
        );

        const duration = Number(result.trim());

        if (!Number.isFinite(duration)) {
            throw new Error('Duração inválida.');
        }

        return duration;
    } catch {
        throw new Error(
            `Não foi possível obter a duração do vídeo:\n${inputPath}`
        );
    }
}

function getTestPositions(duration) {
    const maxStart = Math.max(
        0,
        duration - TEST_DURATION
    );

    return TEST_POSITIONS.map(position => {
        return Math.min(
            maxStart,
            maxStart * position
        );
    });
}

function runFFmpeg(args) {
    return new Promise((resolve, reject) => {
        const ffmpeg = spawn('ffmpeg', args, {
            windowsHide: true
        });

        let output = '';

        ffmpeg.stdout.on('data', data => {
            output += data.toString();
        });

        ffmpeg.stderr.on('data', data => {
            output += data.toString();
        });

        ffmpeg.on('error', error => {
            reject(error);
        });

        ffmpeg.on('close', code => {
            if (code !== 0) {
                reject(
                    new Error(
                        `FFmpeg terminou com código ${code}.\n\n${output}`
                    )
                );

                return;
            }

            resolve(output);
        });
    });
}

async function createTestVideo(
    inputPath,
    outputPath,
    startTime,
    cq
) {
    await runFFmpeg([
        '-hide_banner',
        '-loglevel', 'error',

        '-ss', String(startTime),
        '-t', String(TEST_DURATION),

        '-i', inputPath,

        '-an',

        '-c:v', 'hevc_nvenc',
        '-cq', String(cq),
        '-preset', PRESET,

        '-y',
        outputPath
    ]);
}

async function createOriginalSegment(
    inputPath,
    outputPath,
    startTime
) {
    await runFFmpeg([
        '-hide_banner',
        '-loglevel', 'error',

        '-ss', String(startTime),
        '-t', String(TEST_DURATION),

        '-i', inputPath,

        '-an',

        '-c:v', 'copy',

        '-y',
        outputPath
    ]);
}

async function calculateVMAF(
    originalPath,
    compressedPath
) {
    const output = await runFFmpeg([
        '-hide_banner',
        '-loglevel', 'info',

        '-i', originalPath,
        '-i', compressedPath,

        '-filter_complex',
        '[0:v][1:v]libvmaf',

        '-f', 'null',
        '-'
    ]);

    const matches = [
        ...output.matchAll(/VMAF score:\s*([0-9.]+)/gi)
    ];

    if (matches.length === 0) {
        throw new Error(
            'Não foi possível obter o resultado do VMAF.'
        );
    }

    const values = matches.map(
        match => Number(match[1])
    );

    return (
        values.reduce(
            (sum, value) => sum + value,
            0
        ) / values.length
    );
}

async function testSample(
    inputPath,
    startTime,
    cq,
    sampleIndex
) {
    const compressedPath = path.join(
        TEMP_DIR,
        `cq-${cq}-sample-${sampleIndex}-compressed.mp4`
    );

    const originalPath = path.join(
        TEMP_DIR,
        `cq-${cq}-sample-${sampleIndex}-original.mp4`
    );

    try {
        await createOriginalSegment(
            inputPath,
            originalPath,
            startTime
        );

        await createTestVideo(
            inputPath,
            compressedPath,
            startTime,
            cq
        );

        return await calculateVMAF(
            originalPath,
            compressedPath
        );
    } finally {
        if (fs.existsSync(compressedPath)) {
            fs.unlinkSync(compressedPath);
        }

        if (fs.existsSync(originalPath)) {
            fs.unlinkSync(originalPath);
        }
    }
}

async function testCQ(
    inputPath,
    duration,
    cq
) {
    const positions = getTestPositions(duration);

    const results = [];

    for (let i = 0; i < positions.length; i++) {
        const vmaf = await testSample(
            inputPath,
            positions[i],
            cq,
            i
        );

        results.push(vmaf);
    }

    const average =
        results.reduce(
            (sum, value) => sum + value,
            0
        ) / results.length;

    const minimum = Math.min(...results);

    return {
        cq,
        average,
        minimum,
        values: results
    };
}

async function runCQTest(
    inputPath,
    duration,
    cq,
    results
) {
    // Evita testar o mesmo CQ duas vezes
    const existing = results.find(
        result => result.cq === cq
    );

    if (existing) {
        return existing;
    }

    process.stdout.write(
        `\n   🧪 Testando CQ ${cq}...`
    );

    try {
        const result = await testCQ(
            inputPath,
            duration,
            cq
        );

        results.push(result);

        console.log(
            ` VMAF: ${result.average.toFixed(2)}`
        );

        console.log(
            `      Amostras: ${result.values.map(value => value.toFixed(2)).join(' / ')}`
        );

        return result;
    } catch (error) {
        console.log(' ❌');

        console.error(
            `      ${error.message}`
        );

        return null;
    }
}

function isApproved(result) {
    return (
        result.average >= VMAF_TARGET &&
        result.minimum >= VMAF_MIN_SAMPLE
    );
}

async function findBestCQ(
    inputPath,
    duration
) {
    console.log(
        '\n🔬 Analisando qualidade automaticamente...'
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

    console.log(
        `   Amostras: ${TEST_POSITIONS.length} × ${TEST_DURATION}s`
    );

    console.log(
        '   ⚡ Testes sequenciais'
    );

    const results = [];

    /*
     * Primeiro testa os três CQs principais.
     */
    for (const cq of INITIAL_CQ_VALUES) {
        await runCQTest(
            inputPath,
            duration,
            cq,
            results
        );
    }

    if (results.length === 0) {
        throw new Error(
            'Nenhum teste de CQ foi concluído com sucesso.'
        );
    }

    /*
     * Ordena por CQ.
     */
    results.sort(
        (a, b) => a.cq - b.cq
    );

    /*
     * Refinamento adaptativo.
     *
     * Procura o maior CQ aprovado e,
     * caso exista um CQ reprovado acima dele,
     * testa o ponto intermediário.
     */
    while (true) {
        const approved = results.filter(
            isApproved
        );

        const highestApproved =
            approved.length > 0
                ? Math.max(
                    ...approved.map(
                        result => result.cq
                    )
                )
                : null;

        if (highestApproved === null) {
            break;
        }

        const failedAbove =
            results
                .filter(
                    result =>
                        result.cq > highestApproved &&
                        !isApproved(result)
                )
                .sort(
                    (a, b) => a.cq - b.cq
                );

        if (failedAbove.length === 0) {
            /*
             * O maior CQ testado foi aprovado.
             */
            break;
        }

        const lower = highestApproved;
        const upper = failedAbove[0].cq;

        if (upper - lower <= 1) {
            break;
        }

        const middle = Math.floor(
            (lower + upper) / 2
        );

        await runCQTest(
            inputPath,
            duration,
            middle,
            results
        );

        results.sort(
            (a, b) => a.cq - b.cq
        );
    }

    /*
     * Se algum CQ foi aprovado,
     * escolhe o maior CQ aprovado.
     */
    const approved = results.filter(
        isApproved
    );

    if (approved.length > 0) {
        const best =
            approved.reduce(
                (current, result) => {
                    return result.cq > current.cq
                        ? result
                        : current;
                }
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

    /*
     * Nenhum CQ atingiu os critérios.
     *
     * Nesse caso escolhe o resultado com melhor
     * combinação entre VMAF médio e mínimo.
     *
     * O VMAF médio continua sendo o principal
     * critério, com o mínimo servindo como desempate.
     */
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

function processVideo(
    inputFile,
    index,
    total,
    cq
) {
    return new Promise((resolve, reject) => {
        const inputPath =
            path.join(ROOT_DIR, inputFile);

        const outputName =
            path.basename(
                inputFile,
                path.extname(inputFile)
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

        const startTime = Date.now();

        const args = [
            '-hide_banner',

            '-i', inputPath,

            // Vídeo - NVIDIA NVENC
            '-c:v', 'hevc_nvenc',
            '-cq', String(cq),
            '-preset', PRESET,

            // Áudio original
            '-c:a', 'copy',

            // Metadados
            '-map_metadata', '0',

            // Capítulos
            '-map_chapters', '0',

            // Compatibilidade HEVC em MP4
            '-tag:v', 'hvc1',

            '-y',
            outputPath
        ];

        const ffmpeg = spawn(
            'ffmpeg',
            args,
            {
                windowsHide: true
            }
        );

        let errorOutput = '';
        let lastTime = '';

        ffmpeg.stderr.on('data', data => {
            const text = data.toString();

            errorOutput += text;

            const match =
                text.match(
                    /time=\s*([0-9:.]+)/
                );

            if (
                match &&
                match[1] !== lastTime
            ) {
                lastTime = match[1];

                process.stdout.write(
                    `\r   ⏳ Tempo processado: ${lastTime}`
                );
            }
        });

        ffmpeg.on('error', error => {
            reject(
                new Error(
                    `Não foi possível executar o FFmpeg.\n${error.message}`
                )
            );
        });

        ffmpeg.on('close', code => {
            process.stdout.write('\n');

            if (code !== 0) {
                reject(
                    new Error(
                        `FFmpeg terminou com código ${code}.\n\n${errorOutput}`
                    )
                );

                return;
            }

            if (!fs.existsSync(outputPath)) {
                reject(
                    new Error(
                        'O FFmpeg terminou sem gerar o arquivo de saída.'
                    )
                );

                return;
            }

            const originalSize =
                fs.statSync(inputPath).size;

            const processedSize =
                fs.statSync(outputPath).size;

            const reduction =
                (
                    (originalSize - processedSize) /
                    originalSize
                ) * 100;

            const elapsed =
                (Date.now() - startTime) /
                1000;

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

            if (reduction >= 0) {
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
        });
    });
}

function waitForExit(code = 0) {
    console.log(
        '\nPressione qualquer tecla para sair...'
    );

    process.stdin.setRawMode(true);
    process.stdin.resume();

    process.stdin.once('data', () => {
        process.exit(code);
    });
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
        '\n🔍 Verificando ambiente...'
    );

    if (!checkFFmpeg()) {
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

    if (!fs.existsSync(OUTPUT_DIR)) {
        fs.mkdirSync(
            OUTPUT_DIR,
            {
                recursive: true
            }
        );
    }

    if (!fs.existsSync(TEMP_DIR)) {
        fs.mkdirSync(
            TEMP_DIR,
            {
                recursive: true
            }
        );
    }

    const videos = getVideos();

    if (videos.length === 0) {
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
        `🧪 Amostras: ${TEST_POSITIONS.length} × ${TEST_DURATION}s`
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

    for (let i = 0; i < videos.length; i++) {
        const video = videos[i];

        const outputName =
            path.basename(
                video,
                path.extname(video)
            ) + '.mp4';

        const outputPath =
            path.join(
                OUTPUT_DIR,
                outputName
            );

        if (fs.existsSync(outputPath)) {
            continue;
        }

        try {
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

            const cq =
                await findBestCQ(
                    inputPath,
                    duration
                );

            const result =
                await processVideo(
                    video,
                    i + 1,
                    videos.length,
                    cq
                );

            results.push(result);
        } catch (error) {
            console.error(
                `\n   ❌ Erro ao processar ${video}`
            );

            console.error(
                `   ${error.message}`
            );
        }
    }

    try {
        if (fs.existsSync(TEMP_DIR)) {
            fs.rmSync(
                TEMP_DIR,
                {
                    recursive: true,
                    force: true
                }
            );
        }
    } catch {
        // Ignora erro de limpeza
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

    for (const result of results) {
        totalOriginal +=
            result.originalSize;

        totalProcessed +=
            result.processedSize;
    }

    const totalReduction =
        totalOriginal > 0
            ? (
                (totalOriginal - totalProcessed) /
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

    if (totalReduction >= 0) {
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