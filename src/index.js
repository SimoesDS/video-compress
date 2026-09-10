const readline = require('readline');

const normal = require('./modes/normal');
const automatic = require('./modes/automatic');

const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
});

function showMenu() {
    console.clear();

    console.log('========================================');
    console.log('           VIDEO-COMPRESS');
    console.log('========================================');

    console.log('\nEscolha o modo:\n');

    console.log('  1 - Normal');
    console.log('  2 - Automático');

    console.log('');
}

function askMode() {
    return new Promise(resolve => {
        rl.question('Digite uma opção: ', answer => {
            resolve(answer.trim());
        });
    });
}

async function main() {
    showMenu();

    const mode = await askMode();

    rl.close();

    if (mode === '1') {
        await normal();
        return;
    }

    if (mode === '2') {
        await automatic();
        return;
    }

    console.log('\n❌ Opção inválida.');
}

main().catch(error => {
    console.error('\n❌ Erro inesperado:');
    console.error(error);

    process.exit(1);
});