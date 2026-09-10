const fs = require('fs');
const path = require('path');
const { spawn, execFileSync } = require('child_process');

const ROOT_DIR = path.resolve(__dirname, '../..');
const OUTPUT_DIR = path.join(ROOT_DIR, 'processed');

// Configurações de compressão
const CQ = 20;
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

    return true;
}

function processVideo(inputFile, index, total) {
    return new Promise((resolve, reject) => {
        const inputPath = path.join(ROOT_DIR, inputFile);

        const outputName =
            path.basename(inputFile, path.extname(inputFile)) + '.mp4';

        const outputPath = path.join(OUTPUT_DIR, outputName);

        console.log(`\n[${index}/${total}] 🎬 ${inputFile}`);

        const args = [
            '-hide_banner',

            '-i', inputPath,

            // Vídeo - NVIDIA NVENC
            '-c:v', 'hevc_nvenc',
            '-cq', String(CQ),
            '-preset', PRESET,

            // Áudio original sem recompressão
            '-c:a', 'copy',

            // Preserva metadados
            '-map_metadata', '0',

            // Preserva capítulos
            '-map_chapters', '0',

            // Compatibilidade HEVC em MP4
            '-tag:v', 'hvc1',

            outputPath
        ];

        const ffmpeg = spawn('ffmpeg', args, {
            windowsHide: true
        });

        let errorOutput = '';
        let lastTime = '';

        ffmpeg.stderr.on('data', data => {
            const text = data.toString();

            errorOutput += text;

            const match = text.match(/time=\s*([0-9:.]+)/);

            if (match && match[1] !== lastTime) {
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

            const originalSize = fs.statSync(inputPath).size;
            const processedSize = fs.statSync(outputPath).size;

            const reduction =
                ((originalSize - processedSize) / originalSize) * 100;

            console.log(`   ✅ Concluído`);
            console.log(`   Original:    ${formatBytes(originalSize)}`);
            console.log(`   Processado:  ${formatBytes(processedSize)}`);

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
                reduction
            });
        });
    });
}

async function normal() {
    console.log('========================================');
    console.log('           VIDEO-COMPRESS');
    console.log('========================================');

    // Verificação do FFmpeg / NVENC
    console.log('\n🔍 Verificando ambiente...');

    if (!checkFFmpeg()) {
        console.log('\nPressione qualquer tecla para sair...');

        process.stdin.setRawMode(true);
        process.stdin.resume();

        process.stdin.once('data', () => {
            process.exit(1);
        });

        return;
    }

    console.log('   ✅ FFmpeg encontrado');
    console.log('   ✅ NVIDIA NVENC disponível');

    // Cria a pasta processed caso não exista
    if (!fs.existsSync(OUTPUT_DIR)) {
        fs.mkdirSync(OUTPUT_DIR, {
            recursive: true
        });
    }

    // Busca os vídeos
    const videos = getVideos();

    if (videos.length === 0) {
        console.log('\n⚠️ Nenhum arquivo MP4 encontrado.');
        console.log(`\nColoque os vídeos em:\n${ROOT_DIR}`);

        console.log('\nPressione qualquer tecla para sair...');

        process.stdin.setRawMode(true);
        process.stdin.resume();

        process.stdin.once('data', () => {
            process.exit(0);
        });

        return;
    }

    console.log(`\n📁 ${videos.length} vídeo(s) encontrado(s).`);
    console.log('🎮 GPU: NVIDIA NVENC');
    console.log('🎞️ Codec: H.265 / HEVC');
    console.log(`🎯 Qualidade: CQ ${CQ}`);
    console.log(`⚙️ Preset: ${PRESET}`);
    console.log('🔊 Áudio: original');
    console.log('🏷️ Metadados: preservados');

    // Processamento
    const results = [];

    for (let i = 0; i < videos.length; i++) {
        const video = videos[i];

        // Ignora vídeos que já foram processados
        const outputName =
            path.basename(video, path.extname(video)) + '.mp4';

        const outputPath = path.join(OUTPUT_DIR, outputName);

        if (fs.existsSync(outputPath)) {
            continue;
        }

        try {
            const result = await processVideo(
                video,
                i + 1,
                videos.length
            );

            results.push(result);
        } catch (error) {
            console.error(`\n   ❌ Erro ao processar ${video}`);
            console.error(`   ${error.message}`);
        }
    }

    // Resumo final
    console.log('\n========================================');
    console.log('             FINALIZADO');
    console.log('========================================');

    console.log('\n📊 Resumo:');

    let totalOriginal = 0;
    let totalProcessed = 0;

    for (const result of results) {
        totalOriginal += result.originalSize;
        totalProcessed += result.processedSize;
    }

    const totalReduction =
        totalOriginal > 0
            ? ((totalOriginal - totalProcessed) / totalOriginal) * 100
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

    console.log('\n📂 Arquivos salvos em:');
    console.log(`   ${OUTPUT_DIR}`);

    console.log('\nPressione qualquer tecla para sair...');

    process.stdin.setRawMode(true);
    process.stdin.resume();

    process.stdin.once('data', () => {
        process.exit(0);
    });
}

module.exports = normal;