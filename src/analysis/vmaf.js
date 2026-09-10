const fs = require('fs');
const path = require('path');
const {
    spawn,
    execFileSync
} = require('child_process');

const PRESET = 'p5';

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
        `\r      ${label}: ${bar} ${percentage.toFixed(0)}%`
    );
}

function parseTimeToSeconds(value) {
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

function runFFmpeg(
    args,
    duration,
    label,
    options = {}
) {
    return new Promise(
        (resolve, reject) => {
            const ffmpeg =
                spawn(
                    'ffmpeg',
                    [
                        '-progress',
                        'pipe:1',
                        '-stats_period',
                        '0.5',
                        ...args
                    ],
                    {
                        windowsHide: true,
                        cwd: options.cwd
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
                            label
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
                    reject(error);
                }
            );

            ffmpeg.on(
                'close',
                code => {
                    showProgress(
                        duration,
                        duration,
                        label,
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

                    resolve();
                }
            );
        }
    );
}

async function encodeCQ(
    referencePath,
    outputPath,
    cq,
    duration
) {
    await runFFmpeg(
        [
            '-hide_banner',
            '-loglevel',
            'error',

            '-i',
            referencePath,

            '-c:v',
            'hevc_nvenc',

            '-cq',
            String(cq),

            '-preset',
            PRESET,

            '-an',

            '-y',
            outputPath
        ],
        duration,
        '⚙️ Codificando'
    );
}

function getFrameRate(
    inputPath
) {
    try {
        const result =
            execFileSync(
                'ffprobe',
                [
                    '-v',
                    'error',

                    '-select_streams',
                    'v:0',

                    '-show_entries',
                    'stream=avg_frame_rate',

                    '-of',
                    'default=noprint_wrappers=1:nokey=1',

                    inputPath
                ],
                {
                    encoding: 'utf8',
                    windowsHide: true
                }
            );

        const value =
            result.trim();

        const parts =
            value.split('/');

        if (
            parts.length !== 2
        ) {
            throw new Error();
        }

        const numerator =
            Number(parts[0]);

        const denominator =
            Number(parts[1]);

        if (
            !Number.isFinite(
                numerator
            ) ||
            !Number.isFinite(
                denominator
            ) ||
            denominator === 0
        ) {
            throw new Error();
        }

        const fps =
            numerator /
            denominator;

        if (
            !Number.isFinite(fps) ||
            fps <= 0
        ) {
            throw new Error();
        }

        return fps;

    } catch {
        throw new Error(
            `Não foi possível obter o FPS da referência:\n${inputPath}`
        );
    }
}

async function calculateVMAF(
    originalPath,
    compressedPath,
    tempDir,
    duration
) {
    const logPath =
        path.join(
            tempDir,
            'vmaf.json'
        );

    if (
        fs.existsSync(logPath)
    ) {
        fs.unlinkSync(logPath);
    }

    await runFFmpeg(
        [
            '-hide_banner',
            '-loglevel',
            'error',

            '-i',
            originalPath,

            '-i',
            compressedPath,

            '-filter_complex',
            [
                '[0:v]format=yuv420p10le,'
                + 'setpts=PTS-STARTPTS[ref]',

                '[1:v]format=yuv420p10le,'
                + 'setpts=PTS-STARTPTS[dist]',

                '[ref][dist]'
                + 'libvmaf='
                + 'model=version=vmaf_v0.6.1:'
                + 'log_fmt=json:'
                + 'log_path=vmaf.json'
            ].join(';'),

            '-f',
            'null',

            '-'
        ],
        duration,
        '🔬 Calculando VMAF',
        {
            /*
             * O libvmaf interpreta log_path relativo ao
             * diretório de trabalho do FFmpeg. Mantemos
             * "vmaf.json" simples e fazemos esse diretório
             * coincidir com o caminho validado abaixo.
             */
            cwd: tempDir
        }
    );

    if (
        !fs.existsSync(logPath)
    ) {
        throw new Error(
            'O VMAF terminou sem gerar o arquivo de resultados.'
        );
    }

    try {
        return JSON.parse(
            fs.readFileSync(
                logPath,
                'utf8'
            )
        );
    } catch (error) {
        throw new Error(
            `Não foi possível interpretar o resultado do VMAF.\n${error.message}`
        );
    }
}

function extractFrameScores(
    vmafResult
) {
    if (
        !vmafResult ||
        !Array.isArray(
            vmafResult.frames
        )
    ) {
        throw new Error(
            'O resultado do VMAF não contém os frames analisados.'
        );
    }

    const scores =
        vmafResult.frames
            .map(
                frame => {
                    if (
                        frame.metrics
                    ) {
                        if (
                            Number.isFinite(
                                Number(
                                    frame.metrics.vmaf
                                )
                            )
                        ) {
                            return Number(
                                frame.metrics.vmaf
                            );
                        }

                        if (
                            Number.isFinite(
                                Number(
                                    frame.metrics.VMAF_score
                                )
                            )
                        ) {
                            return Number(
                                frame.metrics.VMAF_score
                            );
                        }
                    }

                    if (
                        Number.isFinite(
                            Number(
                                frame.VMAF_score
                            )
                        )
                    ) {
                        return Number(
                            frame.VMAF_score
                        );
                    }

                    return null;
                }
            )
            .filter(
                value =>
                    Number.isFinite(value)
            );

    if (
        scores.length === 0
    ) {
        throw new Error(
            'Nenhum score de VMAF foi encontrado.'
        );
    }

    return scores;
}

function splitSamples(
    frameScores,
    fps,
    sampleCount
) {
    if (
        !Number.isFinite(fps) ||
        fps <= 0
    ) {
        throw new Error(
            'Não foi possível determinar a quantidade de frames por amostra.'
        );
    }

    const samples = [];

    for (
        let index = 0;
        index < sampleCount;
        index++
    ) {
        /*
         * Usa o FPS real para determinar os limites.
         *
         * Isso evita o erro acumulado de vídeos
         * 59.94 fps tratados como 60 fps exatos.
         */
        const start =
            Math.round(
                index * fps
            );

        const end =
            Math.min(
                Math.round(
                    (index + 1) * fps
                ),
                frameScores.length
            );

        const values =
            frameScores.slice(
                start,
                end
            );

        if (
            values.length === 0
        ) {
            continue;
        }

        const average =
            values.reduce(
                (sum, value) =>
                    sum + value,
                0
            ) / values.length;

        const frameMinimum =
            Math.min(
                ...values
            );

        samples.push({
            index:
                index + 1,

            average,

            frameMinimum,

            frameCount:
                values.length
        });
    }

    return samples;
}

async function testCQ(
    referencePath,
    cq,
    tempDir,
    sampleCount,
    duration
) {
    const encodedPath =
        path.join(
            tempDir,
            `cq-${cq}.mp4`
        );

    const fps =
        getFrameRate(
            referencePath
        );

    await encodeCQ(
        referencePath,
        encodedPath,
        cq,
        duration
    );

    const vmafResult =
        await calculateVMAF(
            referencePath,
            encodedPath,
            tempDir,
            duration
        );

    const frameScores =
        extractFrameScores(
            vmafResult
        );

    const samples =
        splitSamples(
            frameScores,
            fps,
            sampleCount
        );

    if (
        samples.length !==
        sampleCount
    ) {
        throw new Error(
            `Esperados ${sampleCount} trechos de VMAF, mas apenas ${samples.length} foram encontrados.`
        );
    }

    /*
     * Média geral dos trechos.
     */
    const average =
        samples.reduce(
            (sum, sample) =>
                sum +
                sample.average,
            0
        ) / samples.length;

    /*
     * O critério mínimo é a menor MÉDIA
     * entre os trechos.
     *
     * Não usamos o pior frame individual,
     * porque um frame isolado não deve reprovar
     * um trecho inteiro.
     */
    const minimum =
        Math.min(
            ...samples.map(
                sample =>
                    sample.average
            )
        );

    return {
        cq,
        average,
        minimum,

        values:
            samples.map(
                sample =>
                    sample.average
            ),

        samples
    };
}

async function testCQs(
    referencePath,
    cqValues,
    tempDir,
    sampleCount = 5,
    duration
) {
    const results = [];

    for (
        const cq of cqValues
    ) {
        console.log(
            `\n   🧪 Testando CQ ${cq}...`
        );

        const result =
            await testCQ(
                referencePath,
                cq,
                tempDir,
                sampleCount,
                duration
            );

        console.log(
            `      VMAF médio: ${result.average.toFixed(2)}`
        );

        console.log(
            `      VMAF mínimo: ${result.minimum.toFixed(2)}`
        );

        console.log(
            `      Amostras: ${result.values
                .map(
                    value =>
                        value.toFixed(2)
                )
                .join(', ')}`
        );

        results.push(
            result
        );
    }

    return results;
}

module.exports = {
    testCQs
};
