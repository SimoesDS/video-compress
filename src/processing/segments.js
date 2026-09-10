const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

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
        `\r   ${label}: ${bar} ${percentage.toFixed(0)}%`
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
    duration = null,
    label = 'Processando'
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
                        windowsHide: true
                    }
                );

            let stderrOutput = '';
            let progressBuffer = '';
            let lastTime = 0;
            let completed = false;

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
                            if (
                                line ===
                                    'progress=end'
                            ) {
                                completed = true;
                            }

                            continue;
                        }

                        if (
                            !duration ||
                            duration <= 0
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
                    if (
                        duration &&
                        duration > 0
                    ) {
                        showProgress(
                            duration,
                            duration,
                            label,
                            true
                        );

                        process.stdout.write(
                            '\n'
                        );
                    }

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

function createFilterGraph(
    positions,
    duration
) {
    const parts = [];

    positions.forEach(
        (position, index) => {
            const start =
                Math.max(
                    0,
                    Math.min(
                        position,
                        Math.max(
                            0,
                            duration - 1
                        )
                    )
                );

            const end =
                Math.min(
                    duration,
                    start + 1
                );

            parts.push(
                `[0:v]trim=start=${start}:end=${end},`
                + 'setpts=PTS-STARTPTS'
                + `[segment${index}]`
            );
        }
    );

    const inputs =
        positions
            .map(
                (_, index) =>
                    `[segment${index}]`
            )
            .join('');

    const concat =
        inputs +
        `concat=n=${positions.length}:v=1:a=0[outv]`;

    return parts
        .concat(concat)
        .join(';');
}

async function createReferenceSegments(
    inputPath,
    positions,
    duration,
    outputPath
) {
    if (
        !Array.isArray(positions) ||
        positions.length === 0
    ) {
        throw new Error(
            'Nenhum trecho foi informado.'
        );
    }

    const filterGraph =
        createFilterGraph(
            positions,
            duration
        );

    const referenceDuration =
        positions.length;

    await runFFmpeg(
        [
            '-hide_banner',
            '-loglevel',
            'error',

            '-i',
            inputPath,

            '-filter_complex',
            filterGraph,

            '-map',
            '[outv]',

            /*
             * FFV1 é realmente lossless.
             *
             * O MKV é utilizado porque suporta
             * corretamente o fluxo FFV1 e vídeo 10-bit.
             */
            '-c:v',
            'ffv1',

            '-level',
            '3',

            '-coder',
            '1',

            '-context',
            '1',

            '-g',
            '1',

            '-an',

            '-y',
            outputPath
        ],
        referenceDuration,
        '✂️ Referência lossless'
    );

    if (
        !fs.existsSync(outputPath)
    ) {
        throw new Error(
            'Os segmentos de referência não foram gerados.'
        );
    }
}

async function prepareSegments(
    inputPath,
    positions,
    duration,
    tempDir
) {
    if (
        !fs.existsSync(tempDir)
    ) {
        fs.mkdirSync(
            tempDir,
            {
                recursive: true
            }
        );
    }

    const referencePath =
        path.join(
            tempDir,
            'reference.mkv'
        );

    /*
     * A referência é criada uma única vez
     * para todos os testes de CQ deste vídeo.
     */
    console.log(
        '\n   ✂️ Preparando referência lossless...'
    );

    await createReferenceSegments(
        inputPath,
        positions,
        duration,
        referencePath
    );

    return {
        referencePath,
        originalPath: referencePath
    };
}

module.exports = {
    prepareSegments
};