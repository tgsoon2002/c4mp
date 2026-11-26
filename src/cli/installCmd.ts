/**
 * P22-install: wires `c4mp install` and `c4mp uninstall` (logic: src/selfInstall.ts) to the real
 * file system, process and terminal.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as readline from 'readline';
import { spawnSync } from 'child_process';
import type { Command } from 'commander';
import { addExamples } from '../cliHelp';
import { TOOL_VERSION } from '../constants';
import { runInstall, runUninstall } from '../selfInstall';
import type { InstallEnv, InstallOptions } from '../selfInstall';

function realEnv(): InstallEnv {
  return {
    platform: process.platform,
    home: os.homedir(),
    localAppData: process.env.LOCALAPPDATA,
    execPath: process.execPath,
    scriptPath: process.argv[1],
    env: process.env,
    isTTY: Boolean(process.stdin.isTTY),
    version: TOOL_VERSION.split('@')[1],
    ask: question =>
      new Promise(resolve => {
        const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
        rl.question(question, answer => {
          rl.close();
          resolve(/^y(es)?$/i.test(answer.trim()));
        });
      }),
    prompt: question =>
      new Promise(resolve => {
        const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
        rl.question(question, answer => {
          rl.close();
          resolve(answer);
        });
      }),
    run: (cmd, args, timeoutMs) => {
      const r = spawnSync(cmd, args, { encoding: 'utf8', timeout: timeoutMs });
      return { status: r.error ? null : r.status, stdout: r.stdout ?? '' };
    },
    fs: {
      mkdirp: d => void fs.mkdirSync(d, { recursive: true }),
      exists: p => fs.existsSync(p),
      isFile: p => fs.lstatSync(p).isFile(),
      copyFile: (a, b) => fs.copyFileSync(a, b),
      rename: (a, b) => fs.renameSync(a, b),
      chmod: (p, m) => fs.chmodSync(p, m),
      unlink: p => fs.unlinkSync(p),
      symlink: (target, linkPath) => fs.symlinkSync(target, linkPath),
      isSymlink: p => {
        try {
          return fs.lstatSync(p).isSymbolicLink();
        } catch {
          return false;
        }
      },
      readText: p => fs.readFileSync(p, 'utf8'),
      writeText: (p, t) => fs.writeFileSync(p, t),
      realpath: p => {
        try {
          return fs.realpathSync(p);
        } catch {
          return p;
        }
      },
      canWrite: d => {
        try {
          fs.accessSync(d, fs.constants.W_OK);
          return true;
        } catch {
          return false;
        }
      },
    },
    out: l => console.log(l),
    err: l => console.error(l),
  };
}

export function registerInstallCommands(program: Command, env: () => InstallEnv = realEnv): void {
  const install = program
    .command('install')
    .description(
      'Make this single-file binary a global command. ' +
        'Copies it to ~/.local/bin (Windows: %LOCALAPPDATA%\\Programs\\c4mp) and, with your consent, adds that folder to PATH. ' +
        'It also keeps a c4pm alias beside it (a link; a copy on Windows) so old scripts and hooks keep working. ' +
        'Shows the plan and asks once; without a terminal it needs --yes. ' +
        'Never uses sudo: for /usr/local/bin run sudo cp yourself',
    )
    .option('--dir <folder>', 'install into this folder instead of the default')
    .option('--yes', 'do it without asking')
    .option('--no-path', 'do not change PATH or any shell profile')
    .option(
      '--old <action>',
      'what to do with every other c4mp or c4pm copy found (PATH, /usr/local/bin, /opt/homebrew/bin, ~/.local/bin): remove, backup (rename to c4mp-<version>) or leave. ' +
        'Without it: asked per copy; with --yes: backup. A copy you cannot write gets its sudo command printed; a Homebrew copy gets brew uninstall c4mp printed',
    )
    .action(async (opts: InstallOptions & { path?: boolean }) => {
      process.exitCode = await runInstall(env(), {
        dir: opts.dir,
        yes: opts.yes,
        noPath: opts.path === false,
        old: opts.old,
      });
    });
  addExamples(install, [
    './c4mp-macos-arm64 install',
    'c4mp install --dir ~/bin --no-path',
    'c4mp install --yes --old backup           rename older copies to c4mp-<version>, put the folder first on PATH',
    'sudo cp ./c4mp /usr/local/bin/c4mp        system-wide: run it yourself',
  ]);

  const uninstall = program
    .command('uninstall')
    .description(
      'Remove the installed binary and the PATH block c4mp added. ' +
        'Removes only the files c4mp and its c4pm alias (.exe on Windows) in the install folder and the marked block in your shell profile; ' +
        'asks once, or use --yes',
    )
    .option('--dir <folder>', 'the folder c4mp was installed into (default: the install default)')
    .option('--yes', 'do it without asking')
    .action(async (opts: InstallOptions) => {
      process.exitCode = await runUninstall(env(), { dir: opts.dir, yes: opts.yes });
    });
  addExamples(uninstall, ['c4mp uninstall', 'c4mp uninstall --dir ~/bin --yes']);
}
