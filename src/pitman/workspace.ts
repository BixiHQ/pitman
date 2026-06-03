import * as vscode from 'vscode';

export function resolvePitmanRoot(context: vscode.ExtensionContext): vscode.Uri {
  const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
  if (workspaceFolder) {
    return vscode.Uri.joinPath(workspaceFolder.uri, '.http');
  }
  return vscode.Uri.joinPath(context.globalStorageUri, '.http');
}
