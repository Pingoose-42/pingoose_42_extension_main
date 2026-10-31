#!/usr/bin/env node
// The portable checks are shared by Windows development and the full Linux suite.
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const args = process.argv.slice(2);
if (args.length > 1 || (args.length === 1 && !['--portable', '--sockets'].includes(args[0]))) {
    console.error('Usage: node src/scripts/test.cjs [--portable | --sockets]');
    process.exit(2);
}

const root = path.resolve(__dirname, '../..');
const portable = args[0] === '--portable';
let checks = 0;
let failed = 0;

function run(command, commandArgs, label, quiet = false, timeout = undefined) {
    const result = spawnSync(command, commandArgs, {
        cwd: root,
        encoding: 'utf8',
        windowsHide: true,
        timeout,
    });
    checks++;
    if (result.error || result.status !== 0) {
        failed++;
        console.error(`FAIL: ${label}`);
        if (result.error) console.error(result.error.message);
        if (result.stdout) process.stderr.write(result.stdout);
        if (result.stderr) process.stderr.write(result.stderr);
    } else if (!quiet) {
        console.log(`PASS: ${label}`);
    }
}

function scripts(directory) {
    return fs
        .readdirSync(path.join(root, directory), { withFileTypes: true })
        .sort((a, b) => a.name.localeCompare(b.name, 'en'))
        .flatMap((entry) => {
            const relative = `${directory}/${entry.name}`;
            if (relative === 'src/tests') return [];
            if (entry.isDirectory()) return scripts(relative);
            return entry.name.endsWith('.js') ? [relative] : [];
        });
}

const sources = scripts('src');
for (const source of sources) run(process.execPath, ['--check', source], source, true);
console.log(`JavaScript syntax: ${sources.length} files, ${failed} failures`);

const tests = fs
    .readdirSync(path.join(root, 'src/tests'))
    .filter((name) => name.endsWith('.cjs') && name !== 'helpers.cjs')
    .sort();
for (const test of tests) run(process.execPath, [`src/tests/${test}`], test);

if (portable) {
    console.log(
        'Not run in portable mode: Linux Python tests, Bash syntax, GSettings schemas, GJS.'
    );
} else {
    run('python3', ['src/tests/updater.py'], 'updater.py');
    run('python3', ['src/tests/installer.py'], 'installer.py');
    run(
        'bash',
        [
            '-n',
            'install.sh',
            'src/scripts/install.sh',
            'src/scripts/test.sh',
            'src/scripts/package.sh',
        ],
        'Bash syntax'
    );
    run('glib-compile-schemas', ['--strict', '--dry-run', 'src/schemas'], 'GSettings schemas');
    if (args[0] === '--sockets') {
        for (const name of [
            'scoped-loopback',
            'rejection-loopback',
            'probe',
            'seat-migration',
            'self-loopback',
            'image-loopback',
            'image-helper-native',
        ]) {
            // A native callback failure can prevent even GLib timeout sources from running.
            run('gjs', [`src/tests/chat-${name}.js`], `GJS chat-${name}`, false, 120_000);
        }
        run('python3', ['-B', 'src/tests/chat-image-worker.py'], 'Native image decoding');
    }
}

console.log(`${checks} checks, ${failed} failures (${portable ? 'portable' : 'full'} suite).`);
process.exitCode = failed ? 1 : 0;
