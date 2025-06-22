import * as vscode from 'vscode';
import { CodeContextProvider } from './codeContextProvider';

export function activate(context: vscode.ExtensionContext) {
    console.log('Code Context Navigator is now active!');

    const provider = new CodeContextProvider(context.extensionUri);

    // Register the show map command
    const showMapCommand = vscode.commands.registerCommand('code-context-map.showMap', () => {
        provider.showCodeMap();
    });

    // Register the refresh map command
    const refreshMapCommand = vscode.commands.registerCommand('code-context-map.refreshMap', () => {
        provider.refreshMap();
    });

    // Watch for file changes to update the map
    const fileWatcher = vscode.workspace.createFileSystemWatcher('**/*.{ts,js}');
    
    fileWatcher.onDidChange((uri) => {
        provider.onFileChanged(uri);
    });

    fileWatcher.onDidCreate((uri) => {
        provider.onFileChanged(uri);
    });

    fileWatcher.onDidDelete((uri) => {
        provider.onFileDeleted(uri);
    });

    // Watch for active editor changes
    const editorWatcher = vscode.window.onDidChangeActiveTextEditor((editor) => {
        if (editor && (editor.document.languageId === 'typescript' || editor.document.languageId === 'javascript')) {
            provider.onActiveEditorChanged(editor);
        }
    });

    context.subscriptions.push(
        showMapCommand,
        refreshMapCommand,
        fileWatcher,
        editorWatcher,
        provider
    );
}

export function deactivate() {
    console.log('Code Context Navigator is now deactivated!');
}