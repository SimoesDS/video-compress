const { spawn, execFileSync } = require('child_process');

const SAMPLE_INTERVAL = 2;
const ANALYSIS_WIDTH = 640;
const MAX_SAMPLES = 5;
const MIN_SAMPLE_DISTANCE = 6;

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

function runAnalysis(inputPath) {
    return new Promise((resolve, reject) => {
        const ffmpeg = spawn(
            'ffmpeg',
            [
                '-hide_banner',
                '-loglevel', 'error',

                '-i', inputPath,

                '-vf',
                [
                    `fps=1/${SAMPLE_INTERVAL}`,
                    `scale=${ANALYSIS_WIDTH}:-2`,
                    'signalstats',
                    'metadata=print:file=-'
                ].join(','),

                '-an',
                '-f', 'null',
                '-'
            ],
            {
                windowsHide: true
            }
        );

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

function parseMetadata(output) {
    const samples = [];

    let current = null;

    let frameCount = 0;
    let yavgCount = 0;
    let yminCount = 0;
    let ymaxCount = 0;
    let ydifCount = 0;
    let satavgCount = 0;

    const lines = output.split(/\r?\n/);

    for (const line of lines) {

        const frame = line.match(
            /^frame:\s*(\d+)/
        );

        if (frame) {
            if (current) {
                samples.push(current);
            }

            frameCount++;

            current = {
                frame: Number(frame[1]),
                brightness: null,
                ymin: null,
                ymax: null,
                contrast: null,
                motion: null,
                saturation: null
            };

            continue;
        }

        if (!current) {
            continue;
        }

        const yavg = line.match(
            /lavfi\.signalstats\.YAVG=([0-9.]+)/
        );

        const ymin = line.match(
            /lavfi\.signalstats\.YMIN=([0-9.]+)/
        );

        const ymax = line.match(
            /lavfi\.signalstats\.YMAX=([0-9.]+)/
        );

        const ydif = line.match(
            /lavfi\.signalstats\.YDIF=([0-9.]+)/
        );

        const satavg = line.match(
            /lavfi\.signalstats\.SATAVG=([0-9.]+)/
        );

        if (yavg) {
            current.brightness = Number(yavg[1]);
            yavgCount++;
        }

        if (ymin) {
            current.ymin = Number(ymin[1]);
            yminCount++;
        }

        if (ymax) {
            current.ymax = Number(ymax[1]);
            ymaxCount++;
        }

        if (ydif) {
            current.motion = Number(ydif[1]);
            ydifCount++;
        }

        if (satavg) {
            current.saturation = Number(satavg[1]);
            satavgCount++;
        }
    }

    if (current) {
        samples.push(current);
    }

    for (const sample of samples) {
        if (
            Number.isFinite(sample.ymin) &&
            Number.isFinite(sample.ymax)
        ) {
            sample.contrast =
                sample.ymax -
                sample.ymin;
        }
    }

    console.log('\n   🔍 Amostras interpretadas:');

    samples.forEach(sample => {
        console.log(
            `      frame ${sample.frame}`
            + ` | brilho=${sample.brightness}`
            + ` | ymin=${sample.ymin}`
            + ` | ymax=${sample.ymax}`
            + ` | contraste=${sample.contrast}`
            + ` | movimento=${sample.motion}`
            + ` | saturação=${sample.saturation}`
        );
    });

    return samples;
}

function normalize(value, minimum, maximum) {
    if (maximum <= minimum) {
        return 0;
    }

    return Math.max(
        0,
        Math.min(
            1,
            (value - minimum) /
            (maximum - minimum)
        )
    );
}

function calculateScores(samples) {
    const validSamples = samples.filter(
        sample =>
            Number.isFinite(sample.brightness) &&
            Number.isFinite(sample.contrast) &&
            Number.isFinite(sample.motion) &&
            Number.isFinite(sample.saturation)
    );

    if (validSamples.length === 0) {
        return [];
    }

    const maxContrast = Math.max(
        ...validSamples.map(
            sample => sample.contrast
        )
    );

    const maxMotion = Math.max(
        ...validSamples.map(
            sample => sample.motion
        )
    );

    const maxSaturation = Math.max(
        ...validSamples.map(
            sample => sample.saturation
        )
    );

    return validSamples.map(
        (sample, index) => {
            /*
             * Contraste/textura:
             * Quanto maior a variação de luminância,
             * maior tende a ser a quantidade de detalhes.
             */
            const detailScore =
                normalize(
                    sample.contrast,
                    10,
                    Math.max(10, maxContrast)
                );

            /*
             * Movimento:
             * YDIF representa a diferença temporal
             * entre frames.
             */
            const motionScore =
                normalize(
                    sample.motion,
                    2,
                    Math.max(2, maxMotion)
                );

            /*
             * Saturação:
             * Não representa diretamente complexidade,
             * mas ajuda a identificar cenas visualmente
             * mais ricas.
             */
            const saturationScore =
                normalize(
                    sample.saturation,
                    20,
                    Math.max(20, maxSaturation)
                );

            /*
             * Regiões muito escuras podem ser difíceis
             * de comprimir devido ao ruído e detalhes
             * de sombra.
             */
            const lowLightScore =
                sample.brightness < 60
                    ? normalize(
                        60 - sample.brightness,
                        0,
                        60
                    )
                    : 0;

            const score =
                detailScore * 0.40 +
                motionScore * 0.35 +
                saturationScore * 0.10 +
                lowLightScore * 0.15;

            return {
                start:
                    index * SAMPLE_INTERVAL,

                score,

                brightness:
                    sample.brightness,

                contrast:
                    sample.contrast,

                motion:
                    sample.motion,

                saturation:
                    sample.saturation
            };
        }
    );
}

function selectSamples(results) {
    const sorted = [...results].sort(
        (a, b) => b.score - a.score
    );

    const selected = [];

    for (const result of sorted) {
        const tooClose =
            selected.some(
                sample =>
                    Math.abs(
                        sample.start -
                        result.start
                    ) < MIN_SAMPLE_DISTANCE
            );

        if (tooClose) {
            continue;
        }

        selected.push(result);

        if (selected.length >= MAX_SAMPLES) {
            break;
        }
    }

    return selected.sort(
        (a, b) => a.start - b.start
    );
}

function formatTime(seconds) {
    const hours =
        Math.floor(seconds / 3600);

    const minutes =
        Math.floor((seconds % 3600) / 60);

    const secs =
        Math.floor(seconds % 60);

    return [
        hours.toString().padStart(2, '0'),
        minutes.toString().padStart(2, '0'),
        secs.toString().padStart(2, '0')
    ].join(':');
}

async function analyzeVideo(inputPath) {
    const duration =
        getVideoDuration(inputPath);

    console.log(
        '\n🧠 Analisando complexidade do vídeo...'
    );

    console.log(
        `   Resolução de análise: ${ANALYSIS_WIDTH}px`
    );

    console.log(
        `   Intervalo: ${SAMPLE_INTERVAL}s`
    );

    console.log(
        '   Método: detalhes + movimento + luminosidade'
    );

    const output =
        await runAnalysis(inputPath);

    const rawSamples =
        parseMetadata(output);

    const results =
        calculateScores(rawSamples);

    if (results.length === 0) {
        throw new Error(
            'Não foi possível calcular a complexidade do vídeo.'
        );
    }

    const selected =
        selectSamples(results);

    console.log(
        `   Amostras analisadas: ${results.length}`
    );

    console.log(
        '\n   🎯 Trechos mais complexos:'
    );

    for (const sample of selected) {
        console.log(
            `      ${formatTime(sample.start)}`
            + ` | score: ${sample.score.toFixed(3)}`
            + ` | detalhe: ${sample.contrast.toFixed(1)}`
            + ` | movimento: ${sample.motion.toFixed(1)}`
        );
    }

    return selected;
}

module.exports = {
    analyzeVideo
};