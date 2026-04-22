import * as vscode from 'vscode';
import { ChatPanel } from './chat/panel';

export function activate(context: vscode.ExtensionContext) {
  context.subscriptions.push(
    vscode.commands.registerCommand('vdsx.openChat', () => ChatPanel.show(context)),
    vscode.commands.registerCommand('vdsx.reloadEcc', () => {
      ChatPanel.show(context);
      // The panel reloads on construction; if already open, user can click Reload ECC in toolbar.
      vscode.window.showInformationMessage('VDS-X: use the "Reload ECC" button in the chat panel.');
    })
  );
}

export function deactivate() {}
