import * as vscode from 'vscode';
import { resolvePitmanRoot } from './pitman/workspace';
import { initializePitmanWorkspace } from './pitman/initializer';
import { openPitmanWebview, navigatePitmanPanel } from './pitman/webview';
import { PitmanSidebarProvider } from './pitman/sidebar';

export function activate(context: vscode.ExtensionContext): void {
  const sidebarProvider = new PitmanSidebarProvider(context);

  // When the sidebar fires a navigation intent, open the panel then navigate.
  sidebarProvider.setNavigateHandler(async msg => {
    // Always ensure the panel is open first.
    try {
      const root = resolvePitmanRoot(context);
      await initializePitmanWorkspace(root);
      await openPitmanWebview(context, root);
    } catch (err) {
      vscode.window.showErrorMessage(`Pitman: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }

    if (msg.type === 'selectRequest') {
      navigatePitmanPanel({ collectionId: msg.collectionId, requestId: msg.requestId });
    } else if (msg.type === 'selectEnvironment') {
      navigatePitmanPanel({ envId: msg.envId });
    } else if (msg.type === 'open') {
      // Panel is already open from above — nothing extra needed.
    } else if (msg.type === 'refresh') {
      // Just re-push sidebar state (handled by the provider itself on refresh message).
      await sidebarProvider.refresh();
    }
  });

  const openCmd = vscode.commands.registerCommand('pitman.open', async () => {
    try {
      const root = resolvePitmanRoot(context);
      await initializePitmanWorkspace(root);
      await openPitmanWebview(context, root);
    } catch (err) {
      vscode.window.showErrorMessage(`Pitman: ${err instanceof Error ? err.message : String(err)}`);
    }
  });

  const sidebarReg = vscode.window.registerWebviewViewProvider(
    'pitman.workspace',
    sidebarProvider,
    { webviewOptions: { retainContextWhenHidden: true } },
  );

  context.subscriptions.push(openCmd, sidebarReg);
}

export function deactivate(): void {}
