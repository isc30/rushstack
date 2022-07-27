// Copyright (c) Microsoft Corporation. All rights reserved. Licensed under the MIT license.
// See LICENSE in the project root for license information.

import * as path from 'path';
import * as os from 'os';
import { RushConfiguration } from '../api/RushConfiguration';
import { NodeJsCompatibility } from '../logic/NodeJsCompatibility';
import {
  AlreadyReportedError,
  Colors,
  ConsoleTerminalProvider,
  EnvironmentMap,
  Executable,
  FileSystem,
  ITerminal,
  ITerminalProvider,
  Terminal
} from '@rushstack/node-core-library';
import { PrintUtilities } from '@rushstack/terminal';
import { RushConstants } from '../logic/RushConstants';
import { Utilities } from '../utilities/Utilities';

import type { IBuiltInPluginConfiguration } from '../pluginFramework/PluginLoader/BuiltInPluginLoader';
import type { SpawnSyncReturns } from 'child_process';

const RUSH_SKIP_CHECKS_PARAMETER: string = '--rush-skip-checks';

/**
 * Options for RushPnpmCommandLineParser
 */
export interface IRushPnpmCommandLineParserOptions {
  alreadyReportedNodeTooNewError?: boolean;
  builtInPluginConfigurations?: IBuiltInPluginConfiguration[];
  terminalProvider?: ITerminalProvider;
}

export class RushPnpmCommandLineParser {
  private _terminal: ITerminal;
  private _rushConfiguration!: RushConfiguration;
  private _pnpmArgs!: string[];
  private _commandName: string | undefined;

  public constructor(options: IRushPnpmCommandLineParserOptions) {
    const { terminalProvider } = options;
    const localTerminalProvider: ITerminalProvider =
      terminalProvider ??
      new ConsoleTerminalProvider({
        debugEnabled: process.argv.indexOf('--debug') >= 0,
        verboseEnabled: process.argv.indexOf('--verbose') >= 0
      });
    this._terminal = new Terminal(localTerminalProvider);

    try {
      // Are we in a Rush repo?
      let rushConfiguration: RushConfiguration | undefined = undefined;
      if (RushConfiguration.tryFindRushJsonLocation()) {
        // showVerbose is false because the logging message may break JSON output
        rushConfiguration = RushConfiguration.loadFromDefaultLocation({ showVerbose: false });
      }

      NodeJsCompatibility.warnAboutCompatibilityIssues({
        isRushLib: true,
        alreadyReportedNodeTooNewError: !!options.alreadyReportedNodeTooNewError,
        rushConfiguration
      });

      if (!rushConfiguration) {
        throw new Error(
          'The "rush-pnpm" command must be executed in a folder that is under a Rush workspace folder'
        );
      }
      this._rushConfiguration = rushConfiguration;

      if (rushConfiguration.packageManager !== 'pnpm') {
        throw new Error(
          'The "rush-pnpm" command requires your rush.json to be configured to use the PNPM package manager'
        );
      }

      if (!rushConfiguration.pnpmOptions.useWorkspaces) {
        throw new Error(
          'The "rush-pnpm" command requires the "useWorkspaces" setting to be enabled in rush.json'
        );
      }

      const workspaceFolder: string = rushConfiguration.commonTempFolder;
      const workspaceFilePath: string = path.join(workspaceFolder, 'pnpm-workspace.yaml');

      if (!FileSystem.exists(workspaceFilePath)) {
        this._terminal.writeErrorLine('Error: The PNPM workspace file has not been generated:');
        this._terminal.writeErrorLine(`  ${workspaceFilePath}\n`);
        this._terminal.writeLine(Colors.cyan(`Do you need to run "rush install" or "rush update"?`));
        throw new AlreadyReportedError();
      }

      if (!FileSystem.exists(rushConfiguration.packageManagerToolFilename)) {
        this._terminal.writeErrorLine('Error: The PNPM local binary has not been installed yet.');
        this._terminal.writeLine('\n' + Colors.cyan(`Do you need to run "rush install" or "rush update"?`));
        throw new AlreadyReportedError();
      }

      // 0 = node.exe
      // 1 = rush-pnpm
      const pnpmArgs: string[] = process.argv.slice(2);

      this._validatePnpmUsage(pnpmArgs);

      this._pnpmArgs = pnpmArgs;
    } catch (error) {
      if (!(error instanceof AlreadyReportedError)) {
        const prefix: string = 'ERROR: ';
        this._terminal.writeErrorLine('\n' + PrintUtilities.wrapWords(prefix + error.message));
      }
    }
  }

  public execute(): void {
    // Node.js can sometimes accidentally terminate with a zero exit code  (e.g. for an uncaught
    // promise exception), so we start with the assumption that the exit code is 1
    // and set it to 0 only on success.
    process.exitCode = 1;
    this._execute();

    if (process.exitCode === 0) {
      this._postExecute();
    }
  }

  private _validatePnpmUsage(pnpmArgs: string[]): void {
    if (pnpmArgs[0] === RUSH_SKIP_CHECKS_PARAMETER) {
      pnpmArgs.shift();
      // Ignore other checks
      return;
    }

    if (pnpmArgs.length === 0) {
      return;
    }
    const firstArg: string = pnpmArgs[0];

    // Detect common safe invocations
    if (pnpmArgs.includes('-h') || pnpmArgs.includes('--help') || pnpmArgs.includes('-?')) {
      return;
    }

    if (pnpmArgs.length === 1) {
      if (firstArg === '-v' || firstArg === '--version') {
        return;
      }
    }

    const BYPASS_NOTICE: string = `To bypass this check, add "${RUSH_SKIP_CHECKS_PARAMETER}" as the very first command line option.`;

    if (!/^[a-z]+([a-z0-9\-])*$/.test(firstArg)) {
      // We can't parse this CLI syntax
      this._terminal.writeErrorLine(
        `Warning: The "rush-pnpm" wrapper expects a command verb before "${firstArg}"\n`
      );
      this._terminal.writeLine(Colors.cyan(BYPASS_NOTICE));
      throw new AlreadyReportedError();
    } else {
      const commandName: string = firstArg;

      // Also accept SKIP_RUSH_CHECKS_PARAMETER immediately after the command verb
      if (pnpmArgs[1] === RUSH_SKIP_CHECKS_PARAMETER) {
        pnpmArgs.splice(1, 1);
        return;
      }

      if (pnpmArgs.indexOf(RUSH_SKIP_CHECKS_PARAMETER) >= 0) {
        // We do not attempt to parse PNPM's complete CLI syntax, so we cannot be sure how to interpret
        // strings that appear outside of the specific patterns that this parser recognizes
        this._terminal.writeErrorLine(
          PrintUtilities.wrapWords(
            `Error: The "${RUSH_SKIP_CHECKS_PARAMETER}" option must be the first parameter for the "rush-pnpm" command.`
          )
        );
        throw new AlreadyReportedError();
      }

      this._commandName = commandName;

      // Warn about commands known not to work
      /* eslint-disable no-fallthrough */
      switch (commandName) {
        // Blocked
        case 'import': {
          this._terminal.writeErrorLine(
            PrintUtilities.wrapWords(
              `Error: The "pnpm ${commandName}" command is known to be incompatible with Rush's environment.`
            ) + '\n'
          );
          this._terminal.writeLine(Colors.cyan(BYPASS_NOTICE));
          throw new AlreadyReportedError();
        }

        // Show warning for install commands
        case 'add':
        case 'install':
        /* synonym */
        case 'i':
        case 'install-test':
        /* synonym */
        case 'it': {
          this._terminal.writeErrorLine(
            PrintUtilities.wrapWords(
              `Error: The "pnpm ${commandName}" command is incompatible with Rush's environment.` +
                ` Use the "rush install" or "rush update" commands instead.`
            ) + '\n'
          );
          this._terminal.writeLine(Colors.cyan(BYPASS_NOTICE));
          throw new AlreadyReportedError();
        }

        // Show warning
        case 'link':
        /* synonym */
        case 'ln':
        case 'remove':
        /* synonym */
        case 'rm':
        case 'unlink':
        case 'update':
        /* synonym */
        case 'up': {
          this._terminal.writeWarningLine(
            PrintUtilities.wrapWords(
              `Warning: The "pnpm ${commandName}" command makes changes that may invalidate Rush's workspace state.`
            ) + '\n'
          );
          this._terminal.writeWarningLine(
            `==> Consider running "rush install" or "rush update" afterwards.\n`
          );
          break;
        }

        // Known safe
        case 'audit':
        case 'exec':
        case 'list':
        /* synonym */
        case 'ls':
        case 'outdated':
        case 'pack':
        case 'patch':
        case 'patch-commit':
        case 'prune':
        case 'publish':
        case 'rebuild':
        /* synonym */
        case 'rb':
        case 'root':
        case 'run':
        case 'start':
        case 'store':
        case 'test':
        /* synonym */
        case 't':
        case 'why': {
          break;
        }

        // Unknown
        default: {
          this._terminal.writeErrorLine(
            PrintUtilities.wrapWords(
              `Error: The "pnpm ${commandName}" command has not been tested with Rush's environment. It may be incompatible.`
            ) + '\n'
          );
          this._terminal.writeLine(Colors.cyan(BYPASS_NOTICE));
          throw new AlreadyReportedError();
        }
      }
      /* eslint-enable no-fallthrough */
    }
  }

  private _execute(): void {
    const rushConfiguration: RushConfiguration = this._rushConfiguration;
    const workspaceFolder: string = rushConfiguration.commonTempFolder;
    const pnpmEnvironmentMap: EnvironmentMap = new EnvironmentMap(process.env);
    pnpmEnvironmentMap.set('NPM_CONFIG_WORKSPACE_DIR', workspaceFolder);

    if (rushConfiguration.pnpmOptions.pnpmStorePath) {
      pnpmEnvironmentMap.set('NPM_CONFIG_STORE_DIR', rushConfiguration.pnpmOptions.pnpmStorePath);
    }

    if (rushConfiguration.pnpmOptions.environmentVariables) {
      for (const [envKey, { value: envValue, override }] of Object.entries(
        rushConfiguration.pnpmOptions.environmentVariables
      )) {
        if (override) {
          pnpmEnvironmentMap.set(envKey, envValue);
        } else {
          if (undefined === pnpmEnvironmentMap.get(envKey)) {
            pnpmEnvironmentMap.set(envKey, envValue);
          }
        }
      }
    }

    const result: SpawnSyncReturns<string> = Executable.spawnSync(
      rushConfiguration.packageManagerToolFilename,
      this._pnpmArgs,
      {
        environmentMap: pnpmEnvironmentMap,
        stdio: 'inherit'
      }
    );
    if (result.error) {
      throw new Error('Failed to invoke PNPM: ' + result.error);
    }
    if (result.status === null) {
      throw new Error('Failed to invoke PNPM: Spawn completed without an exit code');
    }
    process.exitCode = result.status;
  }

  private _postExecute(): void {
    const commandName: string | undefined = this._commandName;
    if (!commandName) {
      return;
    }

    switch (commandName) {
      case 'patch-commit': {
        const commonTempPnpmPatchesFolder: string = path.join(
          this._rushConfiguration.commonTempFolder,
          RushConstants.pnpmPatchesFolderName
        );
        const rushPnpmPatchesFolder: string = path.join(
          this._rushConfiguration.commonFolder,
          'pnpm',
          RushConstants.pnpmPatchesFolderName
        );
        if (FileSystem.exists(commonTempPnpmPatchesFolder)) {
          // Copy common\temp\patches\ to common\pnpm\patches\
          FileSystem.copyFiles({
            sourcePath: commonTempPnpmPatchesFolder,
            destinationPath: rushPnpmPatchesFolder
          });

          // Copy (or delete) common\temp\pnpm-lock.yaml --> common\config\rush\pnpm-lock.yaml
          Utilities.syncFile(
            this._rushConfiguration.tempShrinkwrapFilename,
            this._rushConfiguration.getCommittedShrinkwrapFilename()
          );

          this._terminal.writeWarningLine(
            'Rush refreshed the pnpm patch files in the "common/pnpm/patches" folder and shrinkwrap file.' +
              os.EOL +
              '  Please commit this change to Git.'
          );
        }
        break;
      }
    }
  }
}
