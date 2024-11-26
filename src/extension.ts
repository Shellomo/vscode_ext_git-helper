import * as vscode from 'vscode';
import { simpleGit, SimpleGit } from 'simple-git';
import * as path from 'path';
import { initializeTelemetryReporter, TelemetryLog } from "./telemetry";

export function activate(context: vscode.ExtensionContext) {
    initializeTelemetryReporter(context);
    TelemetryLog('info', 'Extension activated');
    // Initialize git with the workspace path if available
    const workspacePath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    const git: SimpleGit = simpleGit(workspacePath);

    // Register Git Helper commands
    let disposables = [
        // Fix merge conflicts
        vscode.commands.registerCommand('githelper.fixMergeConflicts', async () => {
            TelemetryLog('info', 'Fix merge conflicts command invoked');
            try {
                const editor = vscode.window.activeTextEditor;
                if (!editor) {
                    throw new Error('No active text editor');
                }

                const document = editor.document;
                const text = document.getText();

                // Find conflict markers
                const conflicts = findConflictMarkers(text);

                if (conflicts.length === 0) {
                    vscode.window.showInformationMessage('No merge conflicts found in this file.');
                    return;
                }

                // For each conflict, show quick pick to choose between versions
                for (const conflict of conflicts) {
                    const choice = await vscode.window.showQuickPick(
                        ['Current Changes', 'Incoming Changes', 'Keep Both'],
                        { placeHolder: 'Choose which changes to keep' }
                    );

                    if (!choice) {
                        continue;
                    }

                    // Apply the chosen resolution
                    await resolveConflict(editor, conflict, choice);
                }

                // Save the file
                await document.save();
            } catch (error) {
                const errorMessage = error instanceof Error ? error.message : 'An unknown error occurred';
                vscode.window.showErrorMessage(`Error fixing merge conflicts: ${errorMessage}`);
            }
        }),

        // Undo last commit
        vscode.commands.registerCommand('githelper.undoLastCommit', async () => {
            TelemetryLog('info', 'Undo last commit command invoked');
            try {
                await git.reset(['--soft', 'HEAD~1']);
                vscode.window.showInformationMessage('Successfully undid last commit. Changes are now staged.');
            } catch (error) {
                const errorMessage = error instanceof Error ? error.message : 'An unknown error occurred';
                vscode.window.showErrorMessage(`Error undoing last commit: ${errorMessage}`);
            }
        }),

        // Stash changes
        vscode.commands.registerCommand('githelper.stashChanges', async () => {
            TelemetryLog('info', 'Stash changes command invoked');
            try {
                const message = await vscode.window.showInputBox({
                    prompt: 'Enter stash message (optional)'
                });

                await git.stash(['push', ...(message ? ['-m', message] : [])]);
                vscode.window.showInformationMessage('Successfully stashed changes');
            } catch (error) {
                const errorMessage = error instanceof Error ? error.message : 'An unknown error occurred';
                vscode.window.showErrorMessage(`Error stashing changes: ${errorMessage}`);
            }
        }),

        // Apply stash
        vscode.commands.registerCommand('githelper.applyStash', async () => {
            TelemetryLog('info', 'Apply stash command invoked');
            try {
                const stashList = await git.stash(['list']);
                const stashes = parseStashList(stashList);

                const selected = await vscode.window.showQuickPick(
                    stashes.map(stash => ({
                        label: stash.message,
                        description: stash.id,
                    })),
                    { placeHolder: 'Select stash to apply' }
                );

                if (selected) {
                    await git.stash(['apply', selected.description]);
                    vscode.window.showInformationMessage('Successfully applied stash');
                }
            } catch (error) {
                TelemetryLog('error', `Error applying stash: ${error}`);
                const errorMessage = error instanceof Error ? error.message : 'An unknown error occurred';
                vscode.window.showErrorMessage(`Error applying stash: ${errorMessage}`);
            }
        }),

        // Fix untracked files
        vscode.commands.registerCommand('githelper.fixUntrackedFiles', async () => {
            TelemetryLog('info', 'Fix untracked files command invoked');
            try {
                const status = await git.status();
                const untrackedFiles = status.not_added;

                if (untrackedFiles.length === 0) {
                    vscode.window.showInformationMessage('No untracked files found.');
                    return;
                }

                const selected = await vscode.window.showQuickPick(
                    untrackedFiles,
                    {
                        canPickMany: true,
                        placeHolder: 'Select files to track'
                    }
                );

                if (selected && selected.length > 0) {
                    await git.add(selected);
                    vscode.window.showInformationMessage(`Successfully added ${selected.length} files to git`);
                }
            } catch (error) {
                const errorMessage = error instanceof Error ? error.message : 'An unknown error occurred';
                vscode.window.showErrorMessage(`Error fixing untracked files: ${errorMessage}`);
            }
        }),

        // Clean working directory
        vscode.commands.registerCommand('githelper.cleanWorkingDirectory', async () => {
            TelemetryLog('info', 'Clean working directory command invoked');
            try {
                const result = await vscode.window.showWarningMessage(
                    'This will remove all untracked files. Are you sure?',
                    'Yes', 'No'
                );

                if (result === 'Yes') {
                    await git.clean('f', ['-d']);
                    vscode.window.showInformationMessage('Successfully cleaned working directory');
                }
            } catch (error) {
                const errorMessage = error instanceof Error ? error.message : 'An unknown error occurred';
                vscode.window.showErrorMessage(`Error cleaning working directory: ${errorMessage}`);
            }
        })
    ];

    context.subscriptions.push(...disposables);
}

// Helper functions
function findConflictMarkers(text: string): Array<{
    start: number;
    middle: number;
    end: number;
    currentChanges: string;
    incomingChanges: string;
}> {
    const conflicts = [];
    const lines = text.split('\n');
    
    for (let i = 0; i < lines.length; i++) {
        if (lines[i].startsWith('<<<<<<<')) {
            const startLine = i;
            let middleLine = -1;
            let endLine = -1;
            
            // Find the middle and end markers
            for (let j = i + 1; j < lines.length; j++) {
                if (lines[j].startsWith('=======')) {
                    middleLine = j;
                } else if (lines[j].startsWith('>>>>>>>')) {
                    endLine = j;
                    break;
                }
            }
            
            if (middleLine !== -1 && endLine !== -1) {
                conflicts.push({
                    start: startLine,
                    middle: middleLine,
                    end: endLine,
                    currentChanges: lines.slice(startLine + 1, middleLine).join('\n'),
                    incomingChanges: lines.slice(middleLine + 1, endLine).join('\n')
                });
            }
        }
    }
    
    return conflicts;
}

async function resolveConflict(
    editor: vscode.TextEditor,
    conflict: { start: number; middle: number; end: number; currentChanges: string; incomingChanges: string },
    choice: string
): Promise<void> {
    const document = editor.document;
    const startPos = document.lineAt(conflict.start).range.start;
    const endPos = document.lineAt(conflict.end).range.end;
    
    let replacementText = '';
    switch (choice) {
        case 'Current Changes':
            replacementText = conflict.currentChanges;
            break;
        case 'Incoming Changes':
            replacementText = conflict.incomingChanges;
            break;
        case 'Keep Both':
            replacementText = `${conflict.currentChanges}\n${conflict.incomingChanges}`;
            break;
    }
    
    await editor.edit(editBuilder => {
        editBuilder.replace(new vscode.Range(startPos, endPos), replacementText);
    });
}

function parseStashList(stashList: string): Array<{ id: string; message: string }> {
    return stashList
        .split('\n')
        .filter(line => line.trim())
        .map(line => {
            const match = line.match(/^stash@{\d+}: (.+)$/);
            return {
                id: line.split(':')[0],
                message: match ? match[1] : line
            };
        });
}

export function deactivate() {
    TelemetryLog('info', 'Extension deactivated');
}